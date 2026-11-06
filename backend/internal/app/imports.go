package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	importer "github.com/domyshev/remember-freely/scripts"
)

const maxUploadBytes int64 = 64 << 20

type uploadRecord struct {
	ID            string  `json:"id"`
	Status        string  `json:"status"`
	Started       string  `json:"upload_started_at"`
	Uploaded      *string `json:"uploaded_at"`
	ReportCreated *string `json:"report_created_at"`
	ArchiveHash   *string `json:"archive_sha256"`
	ReportHash    *string `json:"report_sha256"`
	Size          int64   `json:"size_bytes"`
}

const uploadColumns = `id,status,upload_started_at,uploaded_at,report_created_at,archive_sha256,report_sha256,size_bytes`

type rowScanner interface{ Scan(...any) error }

func scanUpload(row rowScanner) (uploadRecord, error) {
	var upload uploadRecord
	err := row.Scan(&upload.ID, &upload.Status, &upload.Started, &upload.Uploaded, &upload.ReportCreated, &upload.ArchiveHash, &upload.ReportHash, &upload.Size)
	return upload, err
}
func (app *App) listUploads(w http.ResponseWriter, r *http.Request) {
	limit, offset := 20, 0
	for name, target := range map[string]*int{"limit": &limit, "offset": &offset} {
		if value := r.URL.Query().Get(name); value != "" {
			n, err := strconv.Atoi(value)
			if err != nil || n < 0 || name == "limit" && (n < 1 || n > 100) {
				app.writeError(w, 422, "Invalid pagination")
				return
			}
			*target = n
		}
	}
	rows, err := app.db.Query(`SELECT `+uploadColumns+` FROM uploads WHERE user_id=? ORDER BY upload_started_at DESC,id DESC LIMIT ? OFFSET ?`, r.Context().Value(userContextKey).(user).ID, limit+1, offset)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	uploads := []uploadRecord{}
	for rows.Next() {
		record, err := scanUpload(rows)
		if err != nil {
			app.serverError(w, err)
			return
		}
		uploads = append(uploads, record)
	}
	if err = rows.Err(); err != nil {
		app.serverError(w, err)
		return
	}
	var next *int
	if len(uploads) > limit {
		uploads = uploads[:limit]
		value := offset + limit
		next = &value
	}
	app.writeJSON(w, 200, map[string]any{"uploads": uploads, "next_offset": next, "max_upload_bytes": maxUploadBytes})
}
func (app *App) getUpload(w http.ResponseWriter, r *http.Request) {
	upload, err := scanUpload(app.db.QueryRow(`SELECT `+uploadColumns+` FROM uploads WHERE id=? AND user_id=?`, r.PathValue("uploadID"), r.Context().Value(userContextKey).(user).ID))
	if errors.Is(err, sql.ErrNoRows) {
		app.writeError(w, 404, "Upload not found")
		return
	}
	if err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, 200, upload)
}
func (app *App) claimImport(owner string) bool {
	app.imports.mu.Lock()
	defer app.imports.mu.Unlock()
	if app.imports.busy[owner] {
		return false
	}
	select {
	case app.imports.slots <- struct{}{}:
		app.imports.busy[owner] = true
		return true
	default:
		return false
	}
}
func (app *App) releaseImport(owner string) {
	app.imports.mu.Lock()
	defer app.imports.mu.Unlock()
	delete(app.imports.busy, owner)
	<-app.imports.slots
}

func (app *App) uploadPack(w http.ResponseWriter, r *http.Request) {
	if media := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]); media != "application/zip" {
		app.writeError(w, 415, "Send the raw ZIP body as application/zip")
		return
	}
	if r.ContentLength > maxUploadBytes {
		app.writeError(w, 413, "ZIP exceeds 64 MiB")
		return
	}
	current := r.Context().Value(userContextKey).(user)
	if !app.claimImport(current.ID) {
		w.Header().Set("Retry-After", "5")
		app.writeError(w, 429, "An import is already running or import capacity is busy")
		return
	}
	defer app.releaseImport(current.ID)
	var recent int
	if err := app.db.QueryRow(`SELECT count(*) FROM uploads WHERE user_id=? AND julianday(upload_started_at)>julianday(?)`, current.ID, time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)).Scan(&recent); err != nil {
		app.serverError(w, err)
		return
	}
	if recent >= 20 {
		w.Header().Set("Retry-After", "3600")
		app.writeError(w, 429, "Account import limit: 20 attempts per hour")
		return
	}

	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(5 * time.Minute))
	_ = controller.SetWriteDeadline(time.Now().Add(8 * time.Minute))
	if err := os.MkdirAll(filepath.Join(app.importRoot(), "pending"), 0700); err != nil {
		app.serverError(w, err)
		return
	}
	temporary, err := os.MkdirTemp(filepath.Join(app.importRoot(), "pending"), "import-")
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer os.RemoveAll(temporary)
	id, err := randomToken(18)
	if err != nil {
		app.serverError(w, err)
		return
	}
	var key any
	if value := r.Context().Value(apiKeyContext); value != nil {
		key = value.(string)
	}
	if _, err = app.db.Exec(`INSERT INTO uploads(id,user_id,key_id,status,upload_started_at) VALUES(?,?,?,'uploading',?)`, id, current.ID, key, utcNow()); err != nil {
		app.serverError(w, err)
		return
	}
	finished := false
	defer func() {
		if !finished {
			_, _ = app.db.Exec(`UPDATE uploads SET status='failed' WHERE id=? AND status IN ('uploading','processing')`, id)
		}
	}()
	file, err := os.OpenFile(filepath.Join(temporary, "input.zip"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		app.serverError(w, err)
		return
	}
	hash := sha256.New()
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	size, copyErr := io.Copy(io.MultiWriter(file, hash), r.Body)
	closeErr := file.Close()
	if copyErr != nil {
		var max *http.MaxBytesError
		if errors.As(copyErr, &max) {
			app.writeError(w, 413, "ZIP exceeds 64 MiB")
		} else {
			app.writeError(w, 400, "ZIP upload was interrupted")
		}
		return
	}
	if closeErr != nil {
		app.serverError(w, closeErr)
		return
	}
	archiveHash := hex.EncodeToString(hash.Sum(nil))
	if _, err = app.db.Exec(`UPDATE uploads SET status='processing',uploaded_at=?,archive_sha256=?,size_bytes=? WHERE id=?`, utcNow(), archiveHash, size, id); err != nil {
		app.serverError(w, err)
		return
	}
	report, accepted, created, err := app.prepareAccountImport(r.Context(), current.ID, id, temporary, key)
	if err != nil {
		if errors.Is(err, errImportKeyInactive) {
			app.writeError(w, 401, "API key was revoked, deleted or expired before activation")
		} else {
			app.logger.Error("import processing failed", "upload_id", id)
			app.writeError(w, 500, "Import processing failed; inspect upload history and retry")
		}
		return
	}
	finished = true
	reportHash := sha256.Sum256(report)
	w.Header().Set("X-Import-ID", id)
	w.Header().Set("X-Archive-SHA256", archiveHash)
	w.Header().Set("X-Report-SHA256", hex.EncodeToString(reportHash[:]))
	w.Header().Set("X-Report-Created-At", created)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="import-`+id+`.json"`)
	if accepted {
		w.WriteHeader(200)
	} else {
		w.WriteHeader(422)
	}
	_, _ = w.Write(report)
}

var errImportKeyInactive = errors.New("import API key is inactive")

func copySnapshot(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("symbolic link in snapshot")
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if !entry.Type().IsRegular() {
			return errors.New("nonregular snapshot file")
		}
		return os.Link(path, target)
	})
}

func (app *App) prepareAccountImport(ctx context.Context, owner, id, temporary string, key any) ([]byte, bool, string, error) {
	store := filepath.Join(temporary, "content")
	createdSnapshot := ""
	activated := false
	defer func() {
		if createdSnapshot != "" && !activated {
			_ = os.RemoveAll(createdSnapshot)
		}
	}()

	var oldVersion string
	err := app.db.QueryRow(`SELECT snapshot FROM account_content WHERE user_id=?`, owner).Scan(&oldVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, false, "", err
	}
	if oldVersion != "" {
		if _, _, err = loadSnapshot(app.accountRoot(owner), oldVersion); err != nil {
			return nil, false, "", err
		}
		if err = copySnapshot(filepath.Join(app.accountRoot(owner), "versions", oldVersion), filepath.Join(store, "versions", oldVersion)); err != nil {
			return nil, false, "", err
		}
		if err = os.WriteFile(filepath.Join(store, "CURRENT"), []byte(oldVersion+"\n"), 0600); err != nil {
			return nil, false, "", err
		}
	}
	script := filepath.Join(temporary, "importer.py")
	reportPath := filepath.Join(temporary, "report.json")
	if err = os.WriteFile(script, importer.Script, 0600); err != nil {
		return nil, false, "", err
	}
	processContext, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(processContext, "python3", script, "--store", store, "import", filepath.Join(temporary, "input.zip"), "--report", reportPath, "--namespace", tokenHash(owner))
	// Never copy importer stderr into logs: validation errors can contain caller notation.
	output, runErr := command.Output()
	var summary struct {
		Accepted bool   `json:"accepted"`
		Snapshot string `json:"snapshot"`
	}
	if err = json.Unmarshal(output, &summary); err != nil {
		return nil, false, "", errors.New("invalid importer response")
	}
	if runErr != nil {
		var exit *exec.ExitError
		if !errors.As(runErr, &exit) || exit.ExitCode() != 1 || summary.Accepted {
			return nil, false, "", errors.New("importer execution failed")
		}
	}
	info, err := os.Stat(reportPath)
	if err != nil {
		return nil, false, "", err
	}
	if info.Size() > 32<<20 {
		return nil, false, "", errors.New("report exceeds response limit")
	}
	report, err := os.ReadFile(reportPath)
	if err != nil {
		return nil, false, "", err
	}
	created := info.ModTime().UTC().Format(time.RFC3339Nano)
	reportHash := sha256.Sum256(report)
	var questions []seedQuestion
	var library topicLibrary
	if summary.Accepted {
		content, assets, err := loadContent(store)
		if err != nil {
			return nil, false, "", err
		}
		if _, _, _, err = combineContent(app, content, assets); err != nil {
			return nil, false, "", err
		}
		raw, _ := content.ReadFile("questions.json")
		if err = json.Unmarshal(raw, &questions); err != nil {
			return nil, false, "", err
		}
		raw, _ = content.ReadFile("library.json")
		if err = json.Unmarshal(raw, &library); err != nil {
			return nil, false, "", err
		}
		destination := filepath.Join(app.accountRoot(owner), "versions", summary.Snapshot)
		if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return nil, false, "", err
		}
		if _, err = os.Stat(destination); os.IsNotExist(err) {
			if err = os.Rename(filepath.Join(store, "versions", summary.Snapshot), destination); err != nil {
				return nil, false, "", err
			}
			createdSnapshot = destination
		} else {
			actual, e1 := os.ReadFile(filepath.Join(destination, "checksums.json"))
			expected, e2 := os.ReadFile(filepath.Join(store, "versions", summary.Snapshot, "checksums.json"))
			if e1 != nil || e2 != nil || !bytes.Equal(actual, expected) {
				return nil, false, "", errors.New("existing account snapshot is damaged")
			}
			if _, _, err = loadSnapshot(app.accountRoot(owner), summary.Snapshot); err != nil {
				return nil, false, "", err
			}
		}
	}
	tx, err := app.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, "", err
	}
	defer tx.Rollback()
	if key != nil {
		var expires string
		var revoked sql.NullString
		err = tx.QueryRow(`SELECT expires_at,revoked_at FROM api_keys WHERE id=? AND user_id=?`, key, owner).Scan(&expires, &revoked)
		expiry, parseErr := time.Parse(time.RFC3339Nano, expires)
		if err != nil || parseErr != nil || revoked.Valid || !time.Now().UTC().Before(expiry) {
			return nil, false, "", errImportKeyInactive
		}
	}
	status := "rejected"
	if summary.Accepted {
		if err = writeQuestions(tx, questions); err != nil {
			return nil, false, "", err
		}
		if err = writeAccountMemberships(tx, owner, library, oldVersion == ""); err != nil {
			return nil, false, "", err
		}
		if _, err = tx.Exec(`INSERT INTO account_content VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET snapshot=excluded.snapshot`, owner, summary.Snapshot); err != nil {
			return nil, false, "", err
		}
		status = "completed"
	}
	if _, err = tx.Exec(`UPDATE uploads SET status=?,report_created_at=?,report_sha256=? WHERE id=? AND user_id=?`, status, created, hex.EncodeToString(reportHash[:]), id, owner); err != nil {
		return nil, false, "", err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, "", err
	}
	activated = true
	return report, summary.Accepted, created, nil
}

func writeAccountMemberships(tx *sql.Tx, owner string, library topicLibrary, initial bool) error {
	rows, err := tx.Query(`SELECT m.topic_id,m.content_id FROM taxonomy_memberships m JOIN account_topics t ON t.topic_id=m.topic_id WHERE t.user_id=? AND m.present=1`, owner)
	if err != nil {
		return err
	}
	previous := map[string]bool{}
	for rows.Next() {
		var topic, question string
		if err = rows.Scan(&topic, &question); err != nil {
			rows.Close()
			return err
		}
		previous[topic+":"+question] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE taxonomy_memberships SET present=0 WHERE topic_id IN (SELECT topic_id FROM account_topics WHERE user_id=?)`, owner); err != nil {
		return err
	}
	for _, node := range library.Nodes {
		if _, err = tx.Exec(`INSERT OR IGNORE INTO account_topics VALUES(?,?)`, node.ID, owner); err != nil {
			return err
		}
	}
	for _, question := range library.Questions {
		for _, topic := range question.TopicIDs {
			if previous[topic+":"+question.CanonicalID] {
				_, err = tx.Exec(`UPDATE taxonomy_memberships SET present=1 WHERE topic_id=? AND content_id=?`, topic, question.CanonicalID)
			} else {
				_, err = tx.Exec(`INSERT INTO taxonomy_memberships VALUES(?,?,1,?,?) ON CONFLICT(topic_id,content_id) DO UPDATE SET present=1,added_at=excluded.added_at,initial_member=excluded.initial_member`, topic, question.CanonicalID, utcNow(), initial)
			}
			if err != nil {
				return fmt.Errorf("update account memberships: %w", err)
			}
		}
	}
	return nil
}
