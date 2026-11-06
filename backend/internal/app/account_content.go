package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sync"
)

type cachedAccount struct {
	version string
	view    *App
}
type accountContent struct {
	mu    sync.Mutex
	views map[string]cachedAccount
}
type importControl struct {
	mu    sync.Mutex
	slots chan struct{}
	busy  map[string]bool
}

func (app *App) importRoot() string {
	if app.cfg.ImportDir != "" {
		return app.cfg.ImportDir
	}
	return filepath.Join(filepath.Dir(app.cfg.DatabasePath), "account-content")
}
func (app *App) accountRoot(id string) string {
	return filepath.Join(app.importRoot(), "accounts", tokenHash(id))
}

func (app *App) accountHandler(handler func(*App) http.HandlerFunc) http.Handler {
	return app.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		view, err := app.accountView(r.Context().Value(userContextKey).(user).ID)
		if err != nil {
			app.serverError(w, err)
			return
		}
		handler(view)(w, r)
	}))
}

func (app *App) accountView(id string) (*App, error) {
	app.accounts.mu.Lock()
	defer app.accounts.mu.Unlock()
	var version string
	err := app.db.QueryRow(`SELECT snapshot FROM account_content WHERE user_id=?`, id).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return app, nil
	}
	if err != nil {
		return nil, err
	}
	if cached, ok := app.accounts.views[id]; ok && cached.version == version {
		return cached.view, nil
	}
	content, assets, err := loadSnapshot(app.accountRoot(id), version)
	if err != nil {
		return nil, err
	}
	merged, images, combined, err := combineContent(app, content, assets)
	if err != nil {
		return nil, err
	}
	view := *app
	view.content, view.assets, view.images = merged, combined, images
	// Keep a bounded cache; active request views remain immutable after eviction.
	if len(app.accounts.views) >= 4 {
		for key := range app.accounts.views {
			delete(app.accounts.views, key)
			break
		}
	}
	app.accounts.views[id] = cachedAccount{version, &view}
	return &view, nil
}

func combineContent(app *App, private contentFiles, assets map[string][]byte) (contentFiles, map[string][]string, map[string][]byte, error) {
	var bank []seedQuestion
	var library topicLibrary
	images := map[string][]string{}
	combined := map[string][]byte{}
	for name, data := range app.assets {
		combined[name] = data
	}
	for name, data := range assets {
		combined[name] = data
	}
	for _, source := range []contentFiles{app.content, private} {
		raw, err := source.ReadFile("questions.json")
		if err != nil {
			return nil, nil, nil, err
		}
		var questions []seedQuestion
		if err = json.Unmarshal(raw, &questions); err != nil {
			return nil, nil, nil, err
		}
		bank = append(bank, questions...)
		raw, err = source.ReadFile("library.json")
		if err != nil {
			return nil, nil, nil, err
		}
		var topics topicLibrary
		if err = json.Unmarshal(raw, &topics); err != nil {
			return nil, nil, nil, err
		}
		library.Nodes = append(library.Nodes, topics.Nodes...)
		library.Questions = append(library.Questions, topics.Questions...)
	}
	for _, q := range bank {
		images[q.ID] = q.Images
	}
	questions, _ := json.Marshal(bank)
	topics, _ := json.Marshal(library)
	snapshot := contentSnapshot{"questions.json": questions, "library.json": topics}
	if err := validateContent(snapshot, combined); err != nil {
		return nil, nil, nil, err
	}
	return snapshot, images, combined, nil
}
