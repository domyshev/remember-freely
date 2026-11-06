package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmptyEngineDoesNotContainAQuestionBank(t *testing.T) {
	application, err := New(Config{DatabasePath: filepath.Join(t.TempDir(), "empty.db"), ContentDir: t.TempDir(), StaticDir: t.TempDir(), EmailMode: "log"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	var count int
	if err := application.db.QueryRow("SELECT count(*) FROM question_contents").Scan(&count); err != nil || count != 0 {
		t.Fatalf("unexpected built-in questions: %d %v", count, err)
	}
}

func TestInstalledPackTrainingAssetsAndRestart(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	store := filepath.Join(root, "content")
	if err := os.MkdirAll(filepath.Join(source, "images"), 0755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../../examples/starter/pack.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack map[string]any
	if err := json.Unmarshal(data, &pack); err != nil {
		t.Fatal(err)
	}
	questions := pack["questions"].([]any)
	questions[0].(map[string]any)["images"] = []string{"images/sample.png"}
	questions[0].(map[string]any)["topic_ids"] = []string{"addition", "nature"}
	data, _ = json.Marshal(pack)
	if err := os.WriteFile(filepath.Join(source, "pack.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "images", "sample.png"), picture.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(root, "input.zip")
	archiveFile, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(archiveFile)
	for name, contents := range map[string][]byte{"pack.json": data, "images/sample.png": picture.Bytes()} {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}
	reportPath := filepath.Join(root, "report.json")
	command := exec.Command("python3", "../../../scripts/content.py", "--store", store, "import", archivePath, "--report", reportPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("import: %s %v", output, err)
	}
	reportData, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Topics []struct {
			InputID    string `json:"input_id"`
			InternalID string `json:"internal_id"`
		} `json:"topics"`
	}
	if err := json.Unmarshal(reportData, &report); err != nil {
		t.Fatal(err)
	}
	additionID := ""
	for _, topic := range report.Topics {
		if topic.InputID == "addition" {
			additionID = topic.InternalID
		}
	}
	if additionID == "" {
		t.Fatal("missing imported topic ID")
	}
	cfg := Config{DatabasePath: filepath.Join(root, "trainer.db"), ContentDir: store, StaticDir: t.TempDir(), SessionSecret: "test-secret-with-more-than-24-characters", EmailMode: "log"}
	application, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	sender := &capturedEmail{}
	application.email = sender
	_, cookie := signInProgressUser(t, application, sender, "pack@example.com")
	response := request(t, application.Handler(), "GET", "/api/library", "", cookie)
	if response.Code != 200 || strings.Contains(response.Body.String(), `"correct"`) || strings.Contains(response.Body.String(), `"answers"`) {
		t.Fatalf("library leaked answer keys: %s", response.Body.String())
	}
	_, members, _, err := application.topicMembers(additionID)
	if err != nil || len(members) != 2 {
		t.Fatalf("topic members: %v %v", members, err)
	}
	response = request(t, application.Handler(), "GET", "/api/topics/"+additionID, "", cookie)
	if response.Code != 200 || strings.Contains(response.Body.String(), `"correct"`) {
		t.Fatalf("topic: %s", response.Body.String())
	}
	var record struct {
		Questions []topicQuestion `json:"questions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	var pictured topicQuestion
	for _, question := range record.Questions {
		if question.Image != "" {
			pictured = question
		}
	}
	if len(pictured.Images) != 1 {
		t.Fatal("missing gallery")
	}
	if response := request(t, application.Handler(), "GET", pictured.Image, "", nil); response.Code != http.StatusUnauthorized {
		t.Fatal("anonymous image access")
	}
	if response := request(t, application.Handler(), "GET", pictured.Image, "", cookie); response.Code != 200 || !bytes.Equal(response.Body.Bytes(), picture.Bytes()) {
		t.Fatal("image bytes were not served")
	}
	question, err := application.loadTopicQuestion(members[0])
	if err != nil {
		t.Fatal(err)
	}
	letter := ""
	for _, answer := range question.Answers {
		if answer.Correct {
			letter = answer.Letter
		}
	}
	body, _ := json.Marshal(map[string]string{"question_id": question.ID, "selected_letter": letter})
	if response := request(t, application.Handler(), "POST", "/api/topics/"+additionID+"/answers", string(body), cookie); response.Code != 200 {
		t.Fatalf("answer failed: %s", response.Body.String())
	}
	application.Close()
	restarted, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	response = request(t, restarted.Handler(), "GET", "/api/questions/progress", "", cookie)
	if response.Code != 200 || !strings.Contains(response.Body.String(), question.ID) {
		t.Fatalf("progress lost on restart: %s", response.Body.String())
	}
	// Corruption must be rejected before a fresh database is created.
	version, _ := os.ReadFile(filepath.Join(store, "CURRENT"))
	if err := os.WriteFile(filepath.Join(store, "versions", strings.TrimSpace(string(version)), "questions.json"), []byte("[]"), 0644); err != nil {
		t.Fatal(err)
	}
	cfg.DatabasePath = filepath.Join(root, "must-not-exist.db")
	if corrupted, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		corrupted.Close()
		t.Fatal("corrupt snapshot accepted")
	}
	if _, err := os.Stat(cfg.DatabasePath); !os.IsNotExist(err) {
		t.Fatal("database was touched before content validation")
	}
}
