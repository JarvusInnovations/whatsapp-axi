package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestVersion(t *testing.T) {
	var out, errb bytes.Buffer
	if code := run(context.Background(), []string{"version"}, &out, &errb); code != 0 {
		t.Fatalf("exit %d: %s", code, errb.String())
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || lines[0] != "whatsapp-axid "+version || !strings.HasPrefix(lines[1], "go.mau.fi/whatsmeow ") {
		t.Fatalf("got %q", out.String())
	}
}

func TestUsageErrors(t *testing.T) {
	cases := [][]string{
		nil,
		{"bogus"},
		{"run"},
		{"init", "--nope"},
		{"remove", "--account"},
		{"init", "--account", "x", "extra"},
		{"version", "extra"},
		{"run", "--account", "x", "--log-level", "loud"},
	}
	for _, args := range cases {
		var out, errb bytes.Buffer
		if code := run(context.Background(), args, &out, &errb); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
}

func TestInitRunRemoveErrors(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir+"/config")
	t.Setenv("XDG_STATE_HOME", dir+"/state")
	t.Setenv("XDG_DATA_HOME", dir+"/data")
	t.Setenv("XDG_RUNTIME_DIR", dir+"/run")

	var out, errb bytes.Buffer
	if code := run(context.Background(), []string{"init", "--account", "BAD"}, &out, &errb); code != 1 {
		t.Fatalf("bad name: exit %d", code)
	}
	if code := run(context.Background(), []string{"init", "--account", "example"}, &out, &errb); code != 0 {
		t.Fatalf("init: exit %d: %s", code, errb.String())
	}
	errb.Reset()
	if code := run(context.Background(), []string{"init", "--account", "example"}, &out, &errb); code != 1 || !strings.Contains(errb.String(), "account exists") {
		t.Fatalf("second init: exit %d: %s", code, errb.String())
	}
	if code := run(context.Background(), []string{"remove", "--account", "example"}, &out, &errb); code != 0 {
		t.Fatalf("remove: exit %d: %s", code, errb.String())
	}
	errb.Reset()
	if code := run(context.Background(), []string{"remove", "--account", "example"}, &out, &errb); code != 1 || !strings.Contains(errb.String(), "no such account") {
		t.Fatalf("second remove: exit %d: %s", code, errb.String())
	}
	errb.Reset()
	if code := run(context.Background(), []string{"run", "--account", "example"}, &out, &errb); code != 1 || !strings.Contains(errb.String(), "no such account") {
		t.Fatalf("run without init: exit %d: %s", code, errb.String())
	}
}
