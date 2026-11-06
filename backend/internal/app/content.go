package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/domyshev/remember-freely/backend/seed"
)

type contentFiles interface {
	ReadFile(string) ([]byte, error)
}

type contentSnapshot map[string][]byte

func (files contentSnapshot) ReadFile(name string) ([]byte, error) {
	if data, ok := files[name]; ok {
		return data, nil
	}
	return nil, fs.ErrNotExist
}

// Content is loaded once per process. Importing a pack never mutates a running session.
func loadContent(directory string) (contentFiles, map[string][]byte, error) {
	assets := map[string][]byte{}
	if directory == "" {
		return seed.Files, assets, nil
	}
	marker, err := os.ReadFile(filepath.Join(directory, "CURRENT"))
	if os.IsNotExist(err) {
		return seed.Files, assets, nil
	}
	if err != nil {
		return nil, nil, err
	}
	version := strings.TrimSpace(string(marker))
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(version) {
		return nil, nil, fmt.Errorf("invalid content snapshot pointer")
	}
	return loadSnapshot(directory, version)
}

func loadSnapshot(directory, version string) (contentFiles, map[string][]byte, error) {
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(version) {
		return nil, nil, fmt.Errorf("invalid snapshot identity")
	}
	assets := map[string][]byte{}
	root := filepath.Join(directory, "versions", version)
	manifest, err := os.ReadFile(filepath.Join(root, "checksums.json"))
	if err != nil {
		return nil, nil, err
	}
	var checksums map[string]string
	if err := json.Unmarshal(manifest, &checksums); err != nil {
		return nil, nil, err
	}
	files := contentSnapshot{}
	var total int64
	for name, expected := range checksums {
		if !fs.ValidPath(name) || strings.Contains(name, `\`) {
			return nil, nil, fmt.Errorf("unsafe content filename")
		}
		path := root
		for _, part := range strings.Split(name, "/") {
			path = filepath.Join(path, part)
			info, err := os.Lstat(path)
			if err != nil || info.Mode()&os.ModeSymlink != 0 {
				return nil, nil, fmt.Errorf("missing file or symbolic link in content snapshot: %s", name)
			}
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 8<<20 {
			return nil, nil, fmt.Errorf("invalid content file: %s", name)
		}
		total += info.Size()
		if total > 256<<20 {
			return nil, nil, fmt.Errorf("installed content exceeds 256 MiB")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, err
		}
		hash := sha256.Sum256(data)
		if hex.EncodeToString(hash[:]) != expected {
			return nil, nil, fmt.Errorf("content checksum mismatch: %s", name)
		}
		if name == "questions.json" || name == "library.json" {
			files[name] = data
		} else if strings.HasPrefix(name, "assets/") {
			assets["/content-assets/"+version+"/"+strings.TrimPrefix(name, "assets/")] = data
		}
	}
	if err := validateContent(files, assets); err != nil {
		return nil, nil, err
	}
	return files, assets, nil
}

func validateContent(files contentFiles, assets map[string][]byte) error {
	raw, err := files.ReadFile("questions.json")
	if err != nil {
		return err
	}
	var bank []seedQuestion
	if err := json.Unmarshal(raw, &bank); err != nil {
		return err
	}
	raw, err = files.ReadFile("library.json")
	if err != nil {
		return err
	}
	var library topicLibrary
	if err := json.Unmarshal(raw, &library); err != nil {
		return err
	}
	nodes := map[string]bool{}
	parents := map[string]string{}
	for _, node := range library.Nodes {
		if node.ID == "" || node.Label == "" || nodes[node.ID] {
			return fmt.Errorf("invalid topic metadata")
		}
		nodes[node.ID] = true
		if node.Parent != nil {
			parents[node.ID] = *node.Parent
		}
	}
	nonleaf := map[string]bool{}
	for id := range nodes {
		seen := map[string]bool{id: true}
		for parent := parents[id]; parent != ""; parent = parents[parent] {
			if !nodes[parent] || seen[parent] {
				return fmt.Errorf("missing parent or topic cycle")
			}
			seen[parent] = true
			nonleaf[parent] = true
		}
	}
	ids := map[string]bool{}
	for _, question := range bank {
		if ids[question.ID] || strings.TrimSpace(question.Question) == "" {
			return fmt.Errorf("duplicate or empty question")
		}
		ids[question.ID] = true
		for _, image := range append(question.Images, question.Image) {
			if image != "" && assets[image] == nil {
				return fmt.Errorf("missing image for %s", question.ID)
			}
		}
	}
	assigned := map[string]bool{}
	for _, question := range library.Questions {
		if !ids[question.CanonicalID] || assigned[question.CanonicalID] || !question.Verified || len(question.TopicIDs) == 0 {
			return fmt.Errorf("invalid question membership")
		}
		assigned[question.CanonicalID] = true
		for _, topic := range question.TopicIDs {
			if !nodes[topic] || nonleaf[topic] {
				return fmt.Errorf("questions must belong to leaf topics")
			}
		}
	}
	if len(assigned) != len(ids) {
		return fmt.Errorf("questions are missing from the library")
	}
	return nil
}

func (app *App) library(w http.ResponseWriter, r *http.Request) {
	data, err := app.content.ReadFile("library.json")
	if err != nil {
		app.serverError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(data)
}

func (app *App) contentAsset(w http.ResponseWriter, r *http.Request) {
	data, ok := app.assets[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Write(data)
}
