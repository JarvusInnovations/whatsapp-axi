package settings

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaults(t *testing.T) {
	s, err := Parse([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if s.Scope != "tagged" || s.DMFrom != "operators" || !s.ParentBuffer || !s.Presence || s.ReadReceipts != "on-keep" ||
		s.Send.FirstContact != "refuse" || s.Send.PerHour != 60 || s.Send.PerMinute != 10 || s.Send.SameTextChats != 3 || s.Send.MaxFileMB != 64 {
		t.Fatalf("defaults: %+v", s)
	}
	if s.EffectiveRetainDays() != 90 {
		t.Error("retain_days defaults to 90 for tagged")
	}
	s.Scope = "full"
	if s.EffectiveRetainDays() != 0 {
		t.Error("retain_days defaults to 0 for full")
	}
}

func TestRejects(t *testing.T) {
	cases := map[string]string{
		`{"bogus":1}`:                                   "bogus",
		`{"scope":"everything"}`:                        "scope",
		`{"dm_from":"all"}`:                             "dm_from",
		`{"chats":{"nope":"full"}}`:                     "chats.nope",
		`{"chats":{"100000000000001@lid":"tagged"}}`:    "chats.100000000000001@lid",
		`{"chats":{"120363000000000001@g.us":"x"}}`:     "chats.120363000000000001@g.us",
		`{"operators":["15550100001"]}`:                 "operators[0]",
		`{"operators":["+15550100001","+15550100001"]}`: "operators[1]",
		`{"parent_buffer":"yes"}`:                       "parent_buffer",
		`{"wake_file":"relative/path"}`:                 "wake_file",
		`{"retain_days":-1}`:                            "retain_days",
		`{"retain_days":1.5}`:                           "retain_days",
		`{"presence":1}`:                                "presence",
		`{"read_receipts":"always"}`:                    "read_receipts",
		`{"send":{"per_hour":0}}`:                       "send.per_hour",
		`{"send":{"burst":1}}`:                          "send.burst",
		`[]`:                                            "object",
		`{"scope":"tagged"} {}`:                         "trailing",
	}
	for in, key := range cases {
		_, err := Parse([]byte(in))
		if err == nil || !strings.Contains(err.Error(), key) {
			t.Errorf("%s: got %v, want an error naming %s", in, err, key)
		}
	}
}

func TestPatch(t *testing.T) {
	s := Default()
	next, err := Patch(s, []byte(`{"scope":"full","send":{"per_hour":30},"chats":{"120363000000000001@g.us":"none"},"wake_file":"/tmp/wake"}`))
	if err != nil {
		t.Fatal(err)
	}
	if next.Scope != "full" || next.Send.PerHour != 30 || next.Send.PerMinute != 10 || next.Chats["120363000000000001@g.us"] != "none" || next.Wake() != "/tmp/wake" {
		t.Fatalf("patched: %+v", next)
	}
	next, err = Patch(next, []byte(`{"chats":{"120363000000000001@g.us":null},"wake_file":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Chats) != 0 || next.WakeFile != nil {
		t.Fatalf("null removes: %+v", next)
	}
	if _, err := Patch(next, []byte(`{"scope":"full","nope":true}`)); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatal("unknown key in a patch")
	}
	// Validated as a whole: one bad value rejects the patch.
	if _, err := Patch(next, []byte(`{"scope":"full","presence":"no"}`)); err == nil {
		t.Fatal("bad value in a patch")
	}
	if !Equal(Default(), Default()) {
		t.Fatal("Equal")
	}
}

func TestWriteAtomic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "settings.json")
	s := Default()
	s.Operators = []string{"+15550100001"}
	if err := Write(p, s); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode: %v %v", fi.Mode(), err)
	}
	got, err := Load(p)
	if err != nil || !Equal(got, s) {
		t.Fatalf("round trip: %v %+v", err, got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}
