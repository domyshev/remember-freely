package app

import (
	"context"
	"database/sql"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const importSchema = `
CREATE TABLE IF NOT EXISTS api_keys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
CREATE TABLE IF NOT EXISTS uploads (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL, status TEXT NOT NULL,
 upload_started_at TEXT NOT NULL, uploaded_at TEXT, report_created_at TEXT,
 archive_sha256 TEXT, report_sha256 TEXT, size_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id,upload_started_at DESC,id);
CREATE TABLE IF NOT EXISTS account_content (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_topics (
 topic_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);`

const apiKeyContext contextKey = "api-key"

func utcNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z") }

func (app *App) importRoutes() {
	app.mux.Handle("GET /api/keys", app.requireUser(http.HandlerFunc(app.listKeys)))
	app.mux.Handle("POST /api/keys", app.requireUser(http.HandlerFunc(app.createKey)))
	app.mux.Handle("POST /api/keys/{keyID}/revoke", app.requireUser(http.HandlerFunc(app.revokeKey)))
	app.mux.Handle("DELETE /api/keys/{keyID}", app.requireUser(http.HandlerFunc(app.deleteKey)))
	app.mux.Handle("POST /api/imports", app.importAuth(http.HandlerFunc(app.uploadPack)))
	app.mux.Handle("GET /api/imports", app.importAuth(http.HandlerFunc(app.listUploads)))
	app.mux.Handle("GET /api/imports/{uploadID}", app.importAuth(http.HandlerFunc(app.getUpload)))
}

func (app *App) sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		scheme := "http"
		if app.cfg.CookieSecure || r.TLS != nil {
			scheme = "https"
		}
		if err != nil || parsed.Scheme != scheme || parsed.Host != r.Host || parsed.User != nil || parsed.Path != "" {
			app.writeError(w, 403, "Same-origin request required")
			return false
		}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		app.writeError(w, 403, "Same-origin request required")
		return false
	}
	return true
}

type apiKeyRecord struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Prefix   string  `json:"prefix"`
	Created  string  `json:"created_at"`
	Expires  string  `json:"expires_at"`
	Revoked  *string `json:"revoked_at"`
	LastUsed *string `json:"last_used_at"`
}

func (app *App) listKeys(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	rows, err := app.db.Query(`SELECT id,name,prefix,created_at,expires_at,revoked_at,last_used_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC`, current.ID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	result := []apiKeyRecord{}
	for rows.Next() {
		var key apiKeyRecord
		if err = rows.Scan(&key.ID, &key.Name, &key.Prefix, &key.Created, &key.Expires, &key.Revoked, &key.LastUsed); err != nil {
			app.serverError(w, err)
			return
		}
		result = append(result, key)
	}
	if err = rows.Err(); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, 200, result)
}
func (app *App) createKey(w http.ResponseWriter, r *http.Request) {
	if !app.sameOrigin(w, r) {
		return
	}
	var input struct {
		Name    string `json:"name"`
		Expires string `json:"expires_at"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	expires, err := time.Parse(time.RFC3339, input.Expires)
	now := time.Now().UTC()
	input.Name = strings.TrimSpace(input.Name)
	if err != nil || expires.Before(now.Add(time.Minute)) || expires.After(now.Add(365*24*time.Hour)) || len(input.Name) < 1 || utf8.RuneCountInString(input.Name) > 80 {
		app.writeError(w, 422, "Use a name (1–80 characters) and expiry between one minute and 365 days")
		return
	}
	current := r.Context().Value(userContextKey).(user)
	tx, err := app.db.Begin()
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow(`SELECT count(*) FROM api_keys WHERE user_id=?`, current.ID).Scan(&count); err != nil {
		app.serverError(w, err)
		return
	}
	if count >= 50 {
		app.writeError(w, 409, "Delete an old key before creating another (50-key limit)")
		return
	}
	id, err := randomToken(18)
	if err != nil {
		app.serverError(w, err)
		return
	}
	secret, err := randomToken(32)
	if err != nil {
		app.serverError(w, err)
		return
	}
	secret = "rf_" + secret
	record := apiKeyRecord{ID: id, Name: input.Name, Prefix: secret[:10], Created: now.Format(time.RFC3339Nano), Expires: expires.UTC().Format(time.RFC3339Nano)}
	if _, err = tx.Exec(`INSERT INTO api_keys(id,user_id,name,digest,prefix,created_at,expires_at) VALUES(?,?,?,?,?,?,?)`, id, current.ID, input.Name, tokenHash(secret), record.Prefix, record.Created, record.Expires); err != nil {
		app.serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, 201, map[string]any{"key": record, "secret": secret})
}
func (app *App) revokeKey(w http.ResponseWriter, r *http.Request) {
	if !app.sameOrigin(w, r) {
		return
	}
	app.mutateKey(w, r, `UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?`, utcNow(), r.PathValue("keyID"), r.Context().Value(userContextKey).(user).ID)
}
func (app *App) deleteKey(w http.ResponseWriter, r *http.Request) {
	if !app.sameOrigin(w, r) {
		return
	}
	app.mutateKey(w, r, `DELETE FROM api_keys WHERE id=? AND user_id=?`, r.PathValue("keyID"), r.Context().Value(userContextKey).(user).ID)
}
func (app *App) mutateKey(w http.ResponseWriter, r *http.Request, query string, args ...any) {
	result, err := app.db.Exec(query, args...)
	if err != nil {
		app.serverError(w, err)
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		app.writeError(w, 404, "Key not found")
		return
	}
	w.WriteHeader(204)
}
func (app *App) importAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := r.Header.Get("Authorization")
		if authorization == "" {
			app.requireUser(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" && !app.sameOrigin(w, r) {
					return
				}
				next.ServeHTTP(w, r)
			})).ServeHTTP(w, r)
			return
		}
		parts := strings.Fields(authorization)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !strings.HasPrefix(parts[1], "rf_") || len(parts[1]) != 46 {
			app.writeError(w, 401, "Invalid API key")
			return
		}
		var current user
		var id, expires string
		var revoked sql.NullString
		err := app.db.QueryRow(`SELECT k.id,u.id,u.email,k.expires_at,k.revoked_at FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.digest=?`, tokenHash(parts[1])).Scan(&id, &current.ID, &current.Email, &expires, &revoked)
		expiry, parseErr := time.Parse(time.RFC3339Nano, expires)
		if err != nil || parseErr != nil || revoked.Valid || !time.Now().UTC().Before(expiry) {
			app.writeError(w, 401, "Invalid or expired API key")
			return
		}
		if _, err = app.db.Exec(`UPDATE api_keys SET last_used_at=? WHERE id=?`, utcNow(), id); err != nil {
			app.serverError(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, current)
		ctx = context.WithValue(ctx, apiKeyContext, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
