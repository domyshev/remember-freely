package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"testing"
)

func translatedTestZIP(t *testing.T) []byte {
	t.Helper()
	input := syntheticZIP(t)
	reader, err := zip.NewReader(bytes.NewReader(input), int64(len(input)))
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, file := range reader.File {
		source, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(source)
		source.Close()
		if err != nil {
			t.Fatal(err)
		}
		if file.Name == "pack.json" {
			var pack map[string]any
			if err = json.Unmarshal(data, &pack); err != nil {
				t.Fatal(err)
			}
			q := pack["questions"].([]any)[0].(map[string]any)
			q["translations"] = map[string]string{"ru": "Сколько будет два плюс два?", "en": "What is two plus two?"}
			q["explanation_translations"] = map[string]string{"ru": "Сложите две пары.", "fr": "Deux paires."}
			q["answers"].([]any)[0].(map[string]any)["translations"] = map[string]string{"ru": "Четыре"}
			data, err = json.Marshal(pack)
			if err != nil {
				t.Fatal(err)
			}
		}
		entry, err := writer.Create(file.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestAccountTranslationsPersistAcrossUpdateAndHistory(t *testing.T) {
	app, sender := newTestApp(t)
	_, cookie := signInProgressUser(t, app, sender, "languages@example.com")
	_, other := signInProgressUser(t, app, sender, "other-languages@example.com")
	_, key := createTestKey(t, app, cookie)
	response := importRequest(app, "POST", "/api/imports", key, bytes.NewReader(syntheticZIP(t)))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var receipt struct {
		Topics []struct {
			InputID string `json:"input_id"`
			ID      string `json:"internal_id"`
		} `json:"topics"`
		Questions []struct {
			InputID string `json:"input_id"`
			ID      string `json:"internal_id"`
		} `json:"questions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	var topic, id string
	for _, row := range receipt.Topics {
		if row.InputID == "addition" {
			topic = row.ID
		}
	}
	for _, row := range receipt.Questions {
		if row.InputID == "two-plus-two" {
			id = row.ID
		}
	}
	response = request(t, app.Handler(), "POST", "/api/topics/"+topic+"/answers", `{"question_id":"`+id+`","selected_letter":"B"}`, cookie)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	response = importRequest(app, "POST", "/api/imports", key, bytes.NewReader(translatedTestZIP(t)))
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	training := request(t, app.Handler(), "GET", "/api/topics/"+topic, "", cookie)
	var data struct {
		Questions []topicQuestion `json:"questions"`
	}
	if err := json.Unmarshal(training.Body.Bytes(), &data); err != nil || training.Code != 200 {
		t.Fatal(training.Body.String())
	}
	var found bool
	for _, q := range data.Questions {
		if q.ID == id {
			found = true
			if q.Translations["ru"] != "Сколько будет два плюс два?" || q.Help["fr"] != "Deux paires." || q.Progress == nil || !q.Progress.Correct {
				t.Fatalf("translation or progress lost: %+v", q)
			}
			if q.Answers[1].Translations["ru"] != "Четыре" {
				t.Fatal("answer translation lost")
			}
		}
	}
	if !found {
		t.Fatal("question identity changed")
	}
	library := request(t, app.Handler(), "GET", "/api/library", "", cookie)
	if !bytes.Contains(library.Body.Bytes(), []byte(`"ru"`)) || !bytes.Contains(library.Body.Bytes(), []byte(`"languages"`)) {
		t.Fatal("library language metadata missing")
	}
	history := request(t, app.Handler(), "GET", "/api/statistics/linear?paged=1", "", cookie)
	if history.Code != 200 || !bytes.Contains(history.Body.Bytes(), []byte("Четыре")) || !bytes.Contains(history.Body.Bytes(), []byte("Сколько будет")) {
		t.Fatal(history.Body.String())
	}
	if isolated := request(t, app.Handler(), "GET", "/api/topics/"+topic, "", other); isolated.Code == 200 {
		t.Fatal("translation metadata leaked across accounts")
	}
	app.accounts.mu.Lock()
	app.accounts.views = map[string]cachedAccount{}
	app.accounts.mu.Unlock()
	response = request(t, app.Handler(), "GET", "/api/topics/"+topic, "", cookie)
	if response.Code != 200 || !bytes.Contains(response.Body.Bytes(), []byte("Четыре")) {
		t.Fatal("translations lost when snapshot reloaded")
	}
}
