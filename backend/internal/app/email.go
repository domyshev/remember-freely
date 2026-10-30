package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/resend/resend-go/v3"
)

type EmailSender interface {
	SendLoginCode(context.Context, string, string) error
}

type logEmailSender struct{ logger *slog.Logger }

func (sender logEmailSender) SendLoginCode(_ context.Context, email, code string) error {
	sender.logger.Warn("development login code", "email", email, "code", code)
	return nil
}

type resendEmailSender struct {
	client *resend.Client
	from   string
}

func (sender resendEmailSender) SendLoginCode(_ context.Context, email, code string) error {
	_, err := sender.client.Emails.Send(&resend.SendEmailRequest{
		From:    sender.from,
		To:      []string{email},
		Subject: "Your sign-in code for Remember Freely",
		Text:    fmt.Sprintf("Your sign-in code: %s\n\nIt is valid for 10 minutes. If you did not request this code, you can ignore this email.", code),
		Html:    fmt.Sprintf(`<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto"><h1 style="color:#0d6b4d">Remember Freely</h1><p>Your sign-in code:</p><p style="font-size:32px;font-weight:800;letter-spacing:8px">%s</p><p>The code is valid for 10 minutes. If you did not request it, you can ignore this email.</p></div>`, code),
	})
	return err
}
