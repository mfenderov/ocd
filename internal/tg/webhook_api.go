package tg

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"
)

func apiBase() string {
	if b := os.Getenv("OCD_TG_API"); b != "" {
		return b
	}
	return "https://api.telegram.org"
}

func setWebhook(ctx context.Context, target, secret string) error {
	token := os.Getenv("OCD_TG_TOKEN")
	if token == "" {
		return fmt.Errorf("no token")
	}
	if _, err := url.ParseRequestURI(target); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"url":          target,
		"secret_token": secret,
		// Both update types: Telegram delivers nothing else. Without
		// callback_query the inline buttons' taps never arrive.
		"allowed_updates": []string{"message", "callback_query"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiBase()+"/bot"+token+"/setWebhook", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		OK   bool   `json:"ok"`
		Desc string `json:"description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	if !out.OK {
		return fmt.Errorf("setWebhook: %s", out.Desc)
	}
	return nil
}

func deleteWebhook(ctx context.Context) error {
	token := os.Getenv("OCD_TG_TOKEN")
	if token == "" {
		return fmt.Errorf("no token")
	}
	payload := []byte(`{"drop_pending_updates":false}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		apiBase()+"/bot"+token+"/deleteWebhook", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		OK   bool   `json:"ok"`
		Desc string `json:"description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	if !out.OK {
		return fmt.Errorf("deleteWebhook: %s", out.Desc)
	}
	return nil
}
