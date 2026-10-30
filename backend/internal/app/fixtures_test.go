package app

import (
	"encoding/json"
	"fmt"
)

// Synthetic arithmetic fixtures exercise training behavior without a question bank.
var testContent = func() contentSnapshot {
	bank := []seedQuestion{}
	nodes := []map[string]any{
		{"id": "demo", "label": "Demonstration", "parent_id": nil},
		{"id": "demo.basics", "label": "Basics", "parent_id": "demo"},
		{"id": "demo.shared", "label": "Review", "parent_id": "demo"},
		{"id": "demo.extra", "label": "Additional practice", "parent_id": "demo"},
	}
	questions := []map[string]any{}
	for number := 1; number <= 12; number++ {
		id := fmt.Sprintf("%024x", number)
		prompt := fmt.Sprintf("What is %d + 1?", number)
		bank = append(bank, seedQuestion{ID: id, Question: prompt, Help: map[string]string{"en": "Add one to the number."}, Answers: []seedAnswer{{Letter: "A", Text: fmt.Sprint(number + 1), Correct: true}, {Letter: "B", Text: fmt.Sprint(number + 2), Correct: false}}})
		topics := []string{"demo.basics", "demo.extra"}
		if number <= 6 {
			topics = append(topics, "demo.shared")
		}
		questions = append(questions, map[string]any{"canonical_id": id, "question": prompt, "question_title": prompt, "verified": true, "topic_ids": topics})
	}
	bankJSON, _ := json.Marshal(bank)
	libraryJSON, _ := json.Marshal(map[string]any{"nodes": nodes, "questions": questions})
	return contentSnapshot{"questions.json": bankJSON, "library.json": libraryJSON}
}()

func topicMembers(id string) (string, []topicReference, []topicReference, error) {
	return (&App{content: testContent}).topicMembers(id)
}
