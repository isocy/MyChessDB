package main

// Downloads the official Stockfish 19 build for this machine from the
// Stockfish project's GitHub release and unpacks the engine executable.

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const stockfishTag = "sf_19"

// Official release files, by GOOS/GOARCH.
var stockfishAssets = map[string]string{
	"windows/amd64": "stockfish-windows-x86-64-universal.zip",
	"windows/arm64": "stockfish-windows-arm64-universal.zip",
	"linux/amd64":   "stockfish-linux-x86-64-universal.tar.gz",
	"linux/arm64":   "stockfish-linux-arm64-universal.tar.gz",
	"darwin/amd64":  "stockfish-macos-universal.tar.gz",
	"darwin/arm64":  "stockfish-macos-universal.tar.gz",
}

// pinnedArchives: SHA-256 of each official release file, computed from the
// file itself. A download that does not match is discarded.
var pinnedArchives = map[string]string{
	"stockfish-windows-x86-64-universal.zip":  "3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7",
	"stockfish-windows-arm64-universal.zip":   "8372ad3f0d7276deb2c70f801f541ec7db463219fc6d9c7592864e542aa4f401",
	"stockfish-linux-x86-64-universal.tar.gz": "9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f",
	"stockfish-linux-arm64-universal.tar.gz":  "fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01",
	"stockfish-macos-universal.tar.gz":        "a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77",
}

func expectedArchiveDigest(asset string) string {
	if override := testOverride("MYCHESSDB_TEST_ARCHIVE_SHA256"); override != "" {
		return override
	}
	return pinnedArchives[asset]
}

func releaseDownloadBase() string {
	if override := testOverride("MYCHESSDB_TEST_RELEASE_BASE"); override != "" {
		return override
	}
	return "https://github.com/official-stockfish/Stockfish/releases/download/" + stockfishTag + "/"
}

type installStatus struct {
	State    string `json:"state"` // idle | checking | downloading | unpacking | verifying | done | error
	Progress int    `json:"progress"`
	Error    string `json:"error,omitempty"`
}

type installer struct {
	dir      string
	store    *configStore
	verifier *engineVerifier

	mu     sync.Mutex
	status installStatus
	busy   bool
}

func (in *installer) current() installStatus {
	in.mu.Lock()
	defer in.mu.Unlock()
	return in.status
}

func (in *installer) set(state string, progress int) {
	in.mu.Lock()
	in.status = installStatus{State: state, Progress: progress}
	in.mu.Unlock()
}

// start begins an installation unless one is already running.
func (in *installer) start() bool {
	in.mu.Lock()
	if in.busy {
		in.mu.Unlock()
		return false
	}
	in.busy = true
	in.status = installStatus{State: "checking"}
	in.mu.Unlock()
	go func() {
		err := in.run()
		in.mu.Lock()
		in.busy = false
		if err != nil {
			in.status = installStatus{State: "error", Error: err.Error()}
			logf("Stockfish install failed: %v", err)
		} else {
			in.status = installStatus{State: "done", Progress: 100}
		}
		in.mu.Unlock()
	}()
	return true
}

var downloadClient = &http.Client{Timeout: 30 * time.Minute}

type progressWriter struct {
	total   int64
	written int64
	report  func(percent int)
}

func (p *progressWriter) Write(data []byte) (int, error) {
	p.written += int64(len(data))
	if p.total > 0 {
		p.report(int(p.written * 100 / p.total))
	}
	return len(data), nil
}

func (in *installer) run() error {
	asset, ok := stockfishAssets[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return fmt.Errorf("there is no official %s download for %s/%s", engineVersionName, runtime.GOOS, runtime.GOARCH)
	}
	engineDir := filepath.Join(in.dir, "engines", stockfishTag)
	if err := os.MkdirAll(engineDir, 0o755); err != nil {
		return err
	}
	wantDigest := expectedArchiveDigest(asset)
	if wantDigest == "" {
		return fmt.Errorf("no checksum is pinned for %s", asset)
	}
	logf("Downloading the official %s (%s) from github.com/official-stockfish ...", engineVersionName, asset)

	in.set("downloading", 0)
	response, err := downloadClient.Get(releaseDownloadBase() + asset)
	if err != nil {
		return fmt.Errorf("could not download Stockfish: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("could not download Stockfish: the server answered %s", response.Status)
	}
	archivePath := filepath.Join(engineDir, asset+".download")
	archive, err := os.Create(archivePath)
	if err != nil {
		return err
	}
	defer os.Remove(archivePath)
	hash := sha256.New()
	lastLogged := 0
	progress := &progressWriter{total: response.ContentLength, report: func(percent int) {
		in.set("downloading", percent)
		if percent >= lastLogged+25 {
			lastLogged = percent - percent%25
			logf("  downloaded %d%%", lastLogged)
		}
	}}
	_, err = io.Copy(io.MultiWriter(archive, hash, progress), response.Body)
	if closeErr := archive.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("the Stockfish download was interrupted: %w", err)
	}
	gotDigest := hex.EncodeToString(hash.Sum(nil))
	if gotDigest != wantDigest {
		return fmt.Errorf("the downloaded file does not match the official release's SHA-256 (expected %s, got %s)", wantDigest, gotDigest)
	}

	in.set("unpacking", 100)
	enginePath, engineHash, err := extractEngine(archivePath, engineDir)
	if err != nil {
		return err
	}

	in.set("verifying", 100)
	// verify() accepts the file only if it is one of the pinned official
	// executables and answers as Stockfish 19.
	if _, err := in.verifier.verify(enginePath); err != nil {
		os.Remove(enginePath)
		return fmt.Errorf("the downloaded engine (SHA-256 %s) failed its check: %w", engineHash, err)
	}
	if err := in.store.update(func(data *config) { data.EnginePath = enginePath }); err != nil {
		return err
	}
	logf("%s is installed: %s", engineVersionName, enginePath)
	return nil
}

func looksLikeEngine(name string) bool {
	base := strings.ToLower(path.Base(strings.ReplaceAll(name, `\`, "/")))
	if !strings.HasPrefix(base, "stockfish") {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.HasSuffix(base, ".exe")
	}
	return !strings.Contains(base, ".") || strings.HasSuffix(base, "-universal")
}

// extractEngine unpacks only the engine executable (the largest file named
// stockfish*) into dir and returns its path and SHA-256.
func extractEngine(archivePath, dir string) (string, string, error) {
	write := func(name string, source io.Reader) (string, string, error) {
		target := filepath.Join(dir, filepath.Base(filepath.FromSlash(strings.ReplaceAll(name, `\`, "/"))))
		temporary := target + ".tmp"
		file, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return "", "", err
		}
		hash := sha256.New()
		_, err = io.Copy(io.MultiWriter(file, hash), source)
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			os.Remove(temporary)
			return "", "", fmt.Errorf("could not unpack Stockfish: %w", err)
		}
		os.Remove(target)
		if err := os.Rename(temporary, target); err != nil {
			return "", "", err
		}
		return target, hex.EncodeToString(hash.Sum(nil)), nil
	}

	if strings.HasSuffix(strings.TrimSuffix(archivePath, ".download"), ".zip") {
		reader, err := zip.OpenReader(archivePath)
		if err != nil {
			return "", "", fmt.Errorf("the Stockfish download is not a valid zip file: %w", err)
		}
		defer reader.Close()
		var best *zip.File
		for _, file := range reader.File {
			if file.FileInfo().Mode().IsRegular() && looksLikeEngine(file.Name) &&
				(best == nil || file.UncompressedSize64 > best.UncompressedSize64) {
				best = file
			}
		}
		if best == nil {
			return "", "", errors.New("the Stockfish download does not contain an engine executable")
		}
		source, err := best.Open()
		if err != nil {
			return "", "", err
		}
		defer source.Close()
		return write(best.Name, source)
	}

	// tar.gz: entries can only be read in order, so find the largest
	// candidate first and extract it on a second pass.
	scan := func(visit func(header *tar.Header, body io.Reader) (bool, error)) error {
		file, err := os.Open(archivePath)
		if err != nil {
			return err
		}
		defer file.Close()
		unzipped, err := gzip.NewReader(file)
		if err != nil {
			return fmt.Errorf("the Stockfish download is not a valid archive: %w", err)
		}
		defer unzipped.Close()
		entries := tar.NewReader(unzipped)
		for {
			header, err := entries.Next()
			if err == io.EOF {
				// Read to the very end so gzip checks its checksum.
				if _, err := io.Copy(io.Discard, unzipped); err != nil {
					return fmt.Errorf("the Stockfish download is damaged: %w", err)
				}
				return nil
			}
			if err != nil {
				return fmt.Errorf("the Stockfish download is damaged: %w", err)
			}
			stop, err := visit(header, entries)
			if err != nil || stop {
				return err
			}
		}
	}
	bestName, bestSize := "", int64(-1)
	if err := scan(func(header *tar.Header, _ io.Reader) (bool, error) {
		if header.Typeflag == tar.TypeReg && looksLikeEngine(header.Name) && header.Size > bestSize {
			bestName, bestSize = header.Name, header.Size
		}
		return false, nil
	}); err != nil {
		return "", "", err
	}
	if bestName == "" {
		return "", "", errors.New("the Stockfish download does not contain an engine executable")
	}
	var target, digest string
	err := scan(func(header *tar.Header, body io.Reader) (bool, error) {
		if header.Name != bestName {
			return false, nil
		}
		var err error
		target, digest, err = write(header.Name, body)
		return true, err
	})
	return target, digest, err
}
