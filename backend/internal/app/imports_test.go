package app

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func createTestKey(t *testing.T, app *App, cookie *http.Cookie) (string, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": "Test importer", "expires_at": time.Now().UTC().Add(24 * time.Hour).Format(time.RFC3339)})
	response := request(t, app.Handler(), "POST", "/api/keys", string(body), cookie)
	if response.Code != 201 {
		t.Fatalf("create key: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Secret string       `json:"secret"`
		Key    apiKeyRecord `json:"key"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Secret) != 46 {
		t.Fatal("invalid key length")
	}
	return result.Key.ID, result.Secret
}
func importRequest(app *App, method, path, key string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, body)
	req.Header.Set("Authorization", "Bearer "+key)
	if method == "POST" {
		req.Header.Set("Content-Type", "application/zip")
	}
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, req)
	return response
}
func syntheticZIP(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../../examples/starter/pack.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack map[string]any
	if err = json.Unmarshal(data, &pack); err != nil {
		t.Fatal(err)
	}
	pack["id"] = "private-source-reference"
	pack["questions"].([]any)[0].(map[string]any)["images"] = []string{"images/incoming-example.png"}
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	entry, _ := archive.Create("pack.json")
	data, _ = json.Marshal(pack)
	_, _ = entry.Write(data)

	var picture bytes.Buffer
	if err = png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	entry, _ = archive.Create("images/incoming-example.png")
	_, _ = entry.Write(picture.Bytes())
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func TestAPIKeyLifecycleOwnershipAndScope(t *testing.T) {
	app, sender := newTestApp(t)
	owner, cookie := signInProgressUser(t, app, sender, "api@example.com")
	_, other := signInProgressUser(t, app, sender, "api-other@example.com")
	id, key := createTestKey(t, app, cookie)
	list := request(t, app.Handler(), "GET", "/api/keys", "", cookie)
	if strings.Contains(list.Body.String(), key) || strings.Contains(list.Body.String(), `"digest"`) || strings.Contains(list.Body.String(), `"secret"`) {
		t.Fatal("key material leaked")
	}
	var digest string
	if err := app.db.QueryRow(`SELECT digest FROM api_keys WHERE id=?`, id).Scan(&digest); err != nil || digest != tokenHash(key) {
		t.Fatal("key is not hashed")
	}
	if response := importRequest(app, "GET", "/api/imports", key, nil); response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	if response := importRequest(app, "GET", "/api/keys", key, nil); response.Code != 401 {
		t.Fatal("API key can administer keys")
	}
	if response := importRequest(app, "GET", "/api/library", key, nil); response.Code != 401 {
		t.Fatal("API key has training scope")
	}
	if response := request(t, app.Handler(), "DELETE", "/api/keys/"+id, "", other); response.Code != 404 {
		t.Fatal("other user deleted key")
	}
	badOrigin := httptest.NewRequest("POST", "/api/keys/"+id+"/revoke", nil)
	badOrigin.AddCookie(cookie)
	badOrigin.Header.Set("Origin", "https://other.invalid")
	rr := httptest.NewRecorder()
	app.Handler().ServeHTTP(rr, badOrigin)
	if rr.Code != 403 {
		t.Fatal("cross-origin key mutation accepted")
	}
	if response := request(t, app.Handler(), "POST", "/api/keys/"+id+"/revoke", "", cookie); response.Code != 204 {
		t.Fatal(response.Body.String())
	}
	if response := importRequest(app, "GET", "/api/imports", key, nil); response.Code != 401 {
		t.Fatal("revoked key accepted")
	}
	if response := request(t, app.Handler(), "DELETE", "/api/keys/"+id, "", cookie); response.Code != 204 {
		t.Fatal(response.Body.String())
	}
	if response := importRequest(app, "GET", "/api/imports", key, nil); response.Code != 401 {
		t.Fatal("deleted key accepted")
	}
	id, key = createTestKey(t, app, cookie)
	if _, err := app.db.Exec(`UPDATE api_keys SET expires_at=? WHERE id=?`, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), id); err != nil {
		t.Fatal(err)
	}
	if response := importRequest(app, "GET", "/api/imports", key, nil); response.Code != 401 {
		t.Fatal("expired key accepted")
	}
	if response := request(t, app.Handler(), "POST", "/api/keys", `{"name":"invalid","expires_at":"never"}`, cookie); response.Code != 422 {
		t.Fatal("invalid lifetime accepted")
	}
	var count int
	if err := app.db.QueryRow(`SELECT count(*) FROM api_keys WHERE user_id=?`, owner).Scan(&count); err != nil || count != 1 {
		t.Fatal("key ownership lost")
	}
}
func TestAccountZIPImportHistoryIsolationAndRestart(t *testing.T) {
	app, sender := newTestApp(t)
	owner, cookie := signInProgressUser(t, app, sender, "imports@example.com")
	_, other := signInProgressUser(t, app, sender, "imports-other@example.com")
	keyID, key := createTestKey(t, app, cookie)
	input := syntheticZIP(t)
	response := importRequest(app, "POST", "/api/imports", key, bytes.NewReader(input))
	if response.Code != 200 {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}
	archiveHash := sha256.Sum256(input)
	reportHash := sha256.Sum256(response.Body.Bytes())
	if response.Header().Get("X-Archive-SHA256") != hex.EncodeToString(archiveHash[:]) || response.Header().Get("X-Report-SHA256") != hex.EncodeToString(reportHash[:]) {
		t.Fatal("exact-byte checksum mismatch")
	}
	var report struct {
		Pack struct {
			InternalID string `json:"internal_id"`
		} `json:"pack"`
		Topics []struct {
			InputID    string `json:"input_id"`
			InternalID string `json:"internal_id"`
		} `json:"topics"`
		Questions []struct {
			InternalID string `json:"internal_id"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	topic := ""
	for _, item := range report.Topics {
		if item.InputID == "addition" {
			topic = item.InternalID
		}
	}
	if topic == "" {
		t.Fatal("missing internal topic ID")
	}
	library := request(t, app.Handler(), "GET", "/api/library", "", cookie)
	if !strings.Contains(library.Body.String(), topic) {
		t.Fatal("import unavailable without restart")
	}
	otherLibrary := request(t, app.Handler(), "GET", "/api/library", "", other)
	if strings.Contains(otherLibrary.Body.String(), topic) {
		t.Fatal("private topic leaked")
	}
	if res := request(t, app.Handler(), "GET", "/api/topics/"+topic, "", other); res.Code != 404 {
		t.Fatal("other user can train private topic")
	}
	training := request(t, app.Handler(), "GET", "/api/topics/"+topic, "", cookie)
	if training.Code != 200 || strings.Contains(training.Body.String(), `"correct":`) {
		t.Fatal("training failed or leaked key")
	}
	if !strings.Contains(training.Body.String(), `"letter":"B","text":"4"`) {
		t.Fatal("runtime letters do not match import report")
	}
	var recordTopic struct {
		Questions []topicQuestion `json:"questions"`
	}
	if err := json.Unmarshal(training.Body.Bytes(), &recordTopic); err != nil {
		t.Fatal(err)
	}
	imageURL := ""
	for _, question := range recordTopic.Questions {
		if question.Image != "" {
			imageURL = question.Image
		}
	}
	if imageURL == "" {
		t.Fatal("import image missing")
	}
	if res := request(t, app.Handler(), "GET", imageURL, "", cookie); res.Code != 200 {
		t.Fatal("owner image unavailable")
	}
	if res := request(t, app.Handler(), "GET", imageURL, "", other); res.Code != 404 {
		t.Fatal("private image leaked to another user")
	}
	if res := request(t, app.Handler(), "GET", imageURL, "", nil); res.Code != 401 {
		t.Fatal("anonymous image access")
	}
	// The same author IDs in another account resolve to different internal IDs.
	_, otherKey := createTestKey(t, app, other)
	otherImport := importRequest(app, "POST", "/api/imports", otherKey, bytes.NewReader(input))
	if otherImport.Code != 200 {
		t.Fatal(otherImport.Body.String())
	}
	if strings.Contains(otherImport.Body.String(), report.Pack.InternalID) {
		t.Fatal("account namespaces overlap")
	}
	again := importRequest(app, "POST", "/api/imports", key, bytes.NewReader(input))
	if again.Code != 200 || !strings.Contains(again.Body.String(), `"unchanged": 3`) {
		t.Fatal("repeat import duplicated content")
	}
	var count int
	if err := app.db.QueryRow(`SELECT count(*) FROM question_contents`).Scan(&count); err != nil || count != 18 {
		t.Fatalf("question count: %d %v", count, err)
	}
	history := request(t, app.Handler(), "GET", "/api/imports?limit=1", "", cookie)
	var page struct {
		Uploads []uploadRecord `json:"uploads"`
		Next    *int           `json:"next_offset"`
	}
	if err := json.Unmarshal(history.Body.Bytes(), &page); err != nil || len(page.Uploads) != 1 || page.Next == nil {
		t.Fatal(history.Body.String())
	}
	record := page.Uploads[0]
	if record.Status != "completed" || record.ReportHash == nil || record.ArchiveHash == nil || record.Uploaded == nil || record.ReportCreated == nil {
		t.Fatal("missing history metadata")
	}
	for _, at := range []string{record.Started, *record.Uploaded, *record.ReportCreated} {
		if _, err := time.Parse(time.RFC3339Nano, at); err != nil || !strings.HasSuffix(at, "Z") {
			t.Fatal("time is not UTC")
		}
	}
	if res := request(t, app.Handler(), "GET", "/api/imports/"+record.ID, "", other); res.Code != 404 {
		t.Fatal("history leaked")
	}
	if res := request(t, app.Handler(), "DELETE", "/api/keys/"+keyID, "", cookie); res.Code != 204 {
		t.Fatal(res.Body.String())
	}
	if res := request(t, app.Handler(), "GET", "/api/imports/"+record.ID, "", cookie); res.Code != 200 {
		t.Fatal("key deletion removed history")
	}
	pending, err := os.ReadDir(filepath.Join(app.importRoot(), "pending"))
	if err != nil || len(pending) != 0 {
		t.Fatal("source ZIP or report retained")
	}
	if err = filepath.WalkDir(app.accountRoot(owner), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(data), "private-source-reference") {
				t.Fatal("source identifier retained")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	pendingDirectory := filepath.Join(app.importRoot(), "pending", "abandoned")
	if err := os.MkdirAll(pendingDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pendingDirectory, "input.zip"), []byte("temporary"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := app.cfg
	app.Close()
	restarted, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if res := request(t, restarted.Handler(), "GET", "/api/topics/"+topic, "", cookie); res.Code != 200 {
		t.Fatalf("private training lost on restart: %s", res.Body.String())
	}
	var present int
	if err = restarted.db.QueryRow(`SELECT count(*) FROM taxonomy_memberships WHERE topic_id=? AND present=1`, topic).Scan(&present); err != nil || present != 2 {
		t.Fatal("private membership lost on restart")
	}
}
func TestRejectedZIPAndUploadBoundaries(t *testing.T) {
	app, sender := newTestApp(t)
	owner, cookie := signInProgressUser(t, app, sender, "rejected@example.com")
	_, key := createTestKey(t, app, cookie)
	res := importRequest(app, "POST", "/api/imports", key, strings.NewReader("not a zip"))
	if res.Code != 422 || res.Header().Get("X-Report-SHA256") == "" {
		t.Fatalf("missing rejection report: %d %s", res.Code, res.Body.String())
	}
	var active int
	if err := app.db.QueryRow(`SELECT count(*) FROM account_content WHERE user_id=?`, owner).Scan(&active); err != nil || active != 0 {
		t.Fatal("invalid archive activated")
	}
	oversized := httptest.NewRequest("POST", "/api/imports", strings.NewReader("tiny"))
	oversized.ContentLength = maxUploadBytes + 1
	oversized.Header.Set("Content-Type", "application/zip")
	oversized.Header.Set("Authorization", "Bearer "+key)
	rr := httptest.NewRecorder()
	app.Handler().ServeHTTP(rr, oversized)
	if rr.Code != 413 {
		t.Fatal("oversized length accepted")
	}
	wrongMedia := request(t, app.Handler(), "POST", "/api/imports", `{}`, cookie)
	if wrongMedia.Code != 415 {
		t.Fatal("non-ZIP content type accepted")
	}
	if response := importRequest(app, "GET", "/api/imports?limit=101", key, nil); response.Code != 422 {
		t.Fatal("unbounded pagination accepted")
	}
	// Interrupted operations do not pretend that an archive or report was finalized.
	_, err := app.db.Exec(`INSERT INTO uploads(id,user_id,status,upload_started_at) VALUES('interrupted-test',?,'processing',?)`, owner, utcNow())
	if err != nil {
		t.Fatal(err)
	}
	pendingDirectory := filepath.Join(app.importRoot(), "pending", "abandoned")
	if err := os.MkdirAll(pendingDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pendingDirectory, "input.zip"), []byte("temporary"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := app.cfg
	app.Close()
	restarted, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if pending, err := os.ReadDir(filepath.Join(restarted.importRoot(), "pending")); err == nil && len(pending) > 0 {
		t.Fatal("abandoned ZIP retained")
	}
	var status string
	if err = restarted.db.QueryRow(`SELECT status FROM uploads WHERE id='interrupted-test'`).Scan(&status); err != nil || status != "interrupted" {
		t.Fatal("interrupted upload not recovered")
	}
}

type pausedBody struct {
	data    []byte
	started chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func (body *pausedBody) Read(p []byte) (int, error) {
	body.once.Do(func() { close(body.started); <-body.resume })
	if len(body.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, body.data)
	body.data = body.data[n:]
	return n, nil
}
func TestKeyRevocationDuringUploadPreventsActivation(t *testing.T) {
	app, sender := newTestApp(t)
	owner, cookie := signInProgressUser(t, app, sender, "inflight@example.com")
	id, key := createTestKey(t, app, cookie)
	body := &pausedBody{data: syntheticZIP(t), started: make(chan struct{}), resume: make(chan struct{})}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- importRequest(app, "POST", "/api/imports", key, body) }()
	<-body.started
	if res := importRequest(app, "POST", "/api/imports", key, bytes.NewReader(syntheticZIP(t))); res.Code != 429 {
		t.Fatal("concurrent account import accepted")
	}
	if res := request(t, app.Handler(), "POST", "/api/keys/"+id+"/revoke", "", cookie); res.Code != 204 {
		t.Fatal(res.Body.String())
	}
	close(body.resume)
	res := <-done
	if res.Code != 401 {
		t.Fatalf("in-flight revoked key: %d %s", res.Code, res.Body.String())
	}
	var count int
	if err := app.db.QueryRow(`SELECT count(*) FROM account_content WHERE user_id=?`, owner).Scan(&count); err != nil || count != 0 {
		t.Fatal("revoked import activated")
	}
}

func TestAgentClientSavesExactReportWithoutPrintingCredential(t *testing.T) {
	app, sender := newTestApp(t)
	_, cookie := signInProgressUser(t, app, sender, "client@example.com")
	_, key := createTestKey(t, app, cookie)
	server := httptest.NewServer(app.Handler())
	defer server.Close()
	directory := t.TempDir()
	archive := filepath.Join(directory, "input.zip")
	report := filepath.Join(directory, "report.json")
	if err := os.WriteFile(archive, syntheticZIP(t), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("python3", "../../../examples/api-import.py", server.URL, archive, "--report", report)
	command.Env = append(os.Environ(), "REMEMBER_FREELY_API_KEY="+key)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("client failed: %s %v", output, err)
	}
	if strings.Contains(string(output), key) {
		t.Fatal("client printed credential")
	}
	if !strings.Contains(string(output), "Processing questions") || !strings.Contains(string(output), "checksums verified") {
		t.Fatal("client omitted progress/verification")
	}
	data, err := os.ReadFile(report)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	var expected string
	if err = app.db.QueryRow(`SELECT report_sha256 FROM uploads ORDER BY upload_started_at DESC LIMIT 1`).Scan(&expected); err != nil || expected != hex.EncodeToString(hash[:]) {
		t.Fatal("client rewrote report bytes")
	}
}
