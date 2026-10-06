package main

// Which executables the bridge is willing to run, and the settings file.
//
// The site can ask the bridge to use an engine path, so the bridge must never
// run "whatever file it is pointed at". An executable is accepted only when
// its SHA-256 is one of the official Stockfish 19 builds pinned below, and it
// then has to identify itself as Stockfish 19 over UCI.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const engineVersionName = "Stockfish 19"

// pinnedEngines: SHA-256 of the engine executables inside the official
// Stockfish 19 release (github.com/official-stockfish/Stockfish, tag sf_19).
// Each value was computed from the downloaded release file itself.
var pinnedEngines = map[string]string{
	"45bc8e4969147db9c2eb533810637994619bff0eacc81ccfd9854394901bcbd0": "stockfish-windows-x86-64-universal.exe",
	"3b5881df3d6f92817cf6664a6a18a473b50d424c71a1247fe4268090db281413": "stockfish-windows-arm64-universal.exe",
	"0f83d24cc46d2c66c60f16001af5444873bc112b7d028594513426894c12da19": "stockfish-linux-x86-64-universal",
	"bb6599ef38b7a4ae79200a601c40e81a854219a49dba78b1110e7eb4620609bf": "stockfish-linux-arm64-universal",
	"8eed61129d1493c5d1f2fd9323f0c54c47ac49319911fbde18c6b9c87e8b13c5": "stockfish-macos-universal",
}

type config struct {
	Sites      []string `json:"sites"`
	EnginePath string   `json:"engine_path"`
}

type configStore struct {
	mu   sync.Mutex
	path string
	data config
}

func configDir() (string, error) {
	if override := os.Getenv("MYCHESSDB_HOME"); override != "" {
		return override, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "MyChessDB"), nil
}

func loadConfig(dir string) (*configStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	store := &configStore{path: filepath.Join(dir, "bridge.json")}
	raw, err := os.ReadFile(store.path)
	if err == nil {
		if err := json.Unmarshal(raw, &store.data); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON: %w", store.path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return store, nil
}

func (s *configStore) get() config {
	s.mu.Lock()
	defer s.mu.Unlock()
	copyOf := s.data
	copyOf.Sites = append([]string(nil), s.data.Sites...)
	return copyOf
}

func (s *configStore) update(change func(data *config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	change(&s.data)
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.path)
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type engineCheck struct {
	hash string
	name string
	err  error
}

type engineVerifier struct {
	store *configStore

	mu        sync.Mutex
	hashCache map[string]string      // path|size|mtime -> sha256
	idCache   map[string]engineCheck // sha256 -> UCI identity result
}

func newEngineVerifier(store *configStore) *engineVerifier {
	return &engineVerifier{store: store, hashCache: map[string]string{}, idCache: map[string]engineCheck{}}
}

func cleanEnginePath(raw string) string {
	return strings.Trim(strings.TrimSpace(raw), `"`)
}

// verify answers: may this file be run as the analysis engine?
// It returns the engine's name on success.
func (v *engineVerifier) verify(rawPath string) (string, error) {
	path := cleanEnginePath(rawPath)
	if path == "" {
		return "", errors.New("no Stockfish executable is set")
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("use the full path to the Stockfish executable")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("file not found: %s", path)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("select the Stockfish executable itself, not a folder")
	}
	cacheKey := fmt.Sprintf("%s|%d|%d", path, info.Size(), info.ModTime().UnixNano())
	v.mu.Lock()
	hash, known := v.hashCache[cacheKey]
	v.mu.Unlock()
	if !known {
		hash, err = fileSHA256(path)
		if err != nil {
			return "", fmt.Errorf("could not read the executable: %w", err)
		}
		v.mu.Lock()
		v.hashCache[cacheKey] = hash
		v.mu.Unlock()
	}
	if _, pinned := pinnedEngines[hash]; !pinned && !testTrusted(hash) {
		return "", errors.New("this file is not an official " + engineVersionName +
			" build. Use \"Install Stockfish\" to download the official one.")
	}
	v.mu.Lock()
	cached, checked := v.idCache[hash]
	v.mu.Unlock()
	if checked {
		return cached.name, cached.err
	}
	name, err := identifyEngine(path)
	v.mu.Lock()
	v.idCache[hash] = engineCheck{hash: hash, name: name, err: err}
	v.mu.Unlock()
	return name, err
}

// identifyEngine starts the file briefly and checks that it speaks UCI and
// says it is Stockfish 19.
func identifyEngine(path string) (string, error) {
	proc, err := startUCI(path)
	if err != nil {
		return "", fmt.Errorf("could not start it as a chess engine: %w", err)
	}
	defer proc.kill()
	identity, err := proc.handshake(20 * time.Second)
	if err != nil {
		return "", fmt.Errorf("it did not answer as a UCI chess engine: %w", err)
	}
	proc.quit()
	nameOK := strings.EqualFold(identity.Name, engineVersionName)
	authorOK := strings.Contains(strings.ToLower(identity.Author), "stockfish developers")
	optionsOK := identity.Options["Threads"] && identity.Options["Hash"] && identity.Options["MultiPV"]
	if !nameOK || !authorOK || !optionsOK {
		return "", fmt.Errorf("the engine did not identify itself as %s (it says %q)", engineVersionName, identity.Name)
	}
	return identity.Name, nil
}
