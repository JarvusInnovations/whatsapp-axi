// Package settings loads, validates and atomically writes an account's settings.json
// (specs/daemon.md "Settings"). Validation is strict: an unknown key or a bad value is an error
// that names it.
package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/identity"
)

// Scope values.
const (
	ScopeFull    = "full"
	ScopeTagged  = "tagged"
	ScopeDMOnly  = "dm-only"
	OverrideNone = "none"
)

// Send holds the send limits (specs/sending.md).
type Send struct {
	FirstContact  string `json:"first_contact"`
	PerHour       int    `json:"per_hour"`
	PerMinute     int    `json:"per_minute"`
	SameTextChats int    `json:"same_text_chats"`
	MaxFileMB     int    `json:"max_file_mb"`
}

// Settings is one account's settings.
type Settings struct {
	Scope        string            `json:"scope"`
	DMFrom       string            `json:"dm_from"`
	Chats        map[string]string `json:"chats"`
	Operators    []string          `json:"operators"`
	ParentBuffer bool              `json:"parent_buffer"`
	WakeFile     *string           `json:"wake_file"`
	RetainDays   *int              `json:"retain_days"`
	Presence     bool              `json:"presence"`
	ReadReceipts string            `json:"read_receipts"`
	Send         Send              `json:"send"`
}

// Default returns the settings of a new account.
func Default() Settings {
	return Settings{
		Scope:        ScopeTagged,
		DMFrom:       "operators",
		Chats:        map[string]string{},
		Operators:    []string{},
		ParentBuffer: true,
		Presence:     true,
		ReadReceipts: "on-read",
		Send: Send{
			FirstContact:  "refuse",
			PerHour:       60,
			PerMinute:     10,
			SameTextChats: 3,
			MaxFileMB:     64,
		},
	}
}

// EffectiveRetainDays is retain_days, or its default for the scope when unset: 0 (unlimited) for
// full, 90 otherwise.
func (s Settings) EffectiveRetainDays() int {
	if s.RetainDays != nil {
		return *s.RetainDays
	}
	if s.Scope == ScopeFull {
		return 0
	}
	return 90
}

// Wake returns the wake file path, or "".
func (s Settings) Wake() string {
	if s.WakeFile == nil {
		return ""
	}
	return *s.WakeFile
}

// Error is a validation failure naming the key.
type Error struct {
	Key string
	Msg string
}

func (e *Error) Error() string {
	if e.Key == "" {
		return e.Msg
	}
	return fmt.Sprintf("settings: %s: %s", e.Key, e.Msg)
}

func bad(key, format string, a ...any) error { return &Error{Key: key, Msg: fmt.Sprintf(format, a...)} }

// Parse validates a complete settings document. Keys that are absent take their defaults.
func Parse(data []byte) (Settings, error) {
	m, err := decodeObject(data, "")
	if err != nil {
		return Settings{}, err
	}
	return fromMap(m)
}

func decodeObject(data []byte, key string) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, bad(key, "not valid JSON: %v", err)
	}
	if dec.More() {
		return nil, bad(key, "trailing data after the JSON object")
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, bad(key, "must be a JSON object")
	}
	return m, nil
}

var topKeys = map[string]bool{
	"scope": true, "dm_from": true, "chats": true, "operators": true, "parent_buffer": true,
	"wake_file": true, "retain_days": true, "presence": true, "read_receipts": true, "send": true,
}

var sendKeys = map[string]bool{
	"first_contact": true, "per_hour": true, "per_minute": true, "same_text_chats": true, "max_file_mb": true,
}

func sortedKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func fromMap(m map[string]any) (Settings, error) {
	s := Default()
	for _, k := range sortedKeys(m) {
		if !topKeys[k] {
			return s, bad(k, "unknown key")
		}
	}
	var err error
	if v, ok := m["scope"]; ok {
		if s.Scope, err = enum("scope", v, ScopeFull, ScopeTagged, ScopeDMOnly); err != nil {
			return s, err
		}
	}
	if v, ok := m["dm_from"]; ok {
		if s.DMFrom, err = enum("dm_from", v, "operators", "anyone"); err != nil {
			return s, err
		}
	}
	if v, ok := m["chats"]; ok {
		obj, ok := v.(map[string]any)
		if !ok {
			return s, bad("chats", "must be an object of chat id to scope")
		}
		s.Chats = map[string]string{}
		for _, id := range sortedKeys(obj) {
			key := "chats." + id
			switch {
			case identity.IsGroup(id):
				if s.Chats[id], err = enum(key, obj[id], ScopeFull, ScopeTagged, OverrideNone); err != nil {
					return s, err
				}
			case identity.IsUser(id):
				if s.Chats[id], err = enum(key, obj[id], ScopeFull, OverrideNone); err != nil {
					return s, fmt.Errorf("%w (tagged applies to groups only)", err)
				}
			default:
				return s, bad(key, "not a chat id (a group id, a hidden id or a phone-number id)")
			}
		}
	}
	if v, ok := m["operators"]; ok {
		arr, ok := v.([]any)
		if !ok {
			return s, bad("operators", "must be an array")
		}
		s.Operators = []string{}
		seen := map[string]bool{}
		for i, e := range arr {
			str, ok := e.(string)
			if !ok || !identity.ValidOperator(str) {
				return s, bad(fmt.Sprintf("operators[%d]", i), "must be a phone number in E.164 form (+15550100001) or a hidden id (100000000000001@lid)")
			}
			if seen[str] {
				return s, bad(fmt.Sprintf("operators[%d]", i), "duplicate %s", str)
			}
			seen[str] = true
			s.Operators = append(s.Operators, str)
		}
	}
	if v, ok := m["parent_buffer"]; ok {
		if s.ParentBuffer, err = boolean("parent_buffer", v); err != nil {
			return s, err
		}
	}
	if v, ok := m["wake_file"]; ok && v != nil {
		str, ok := v.(string)
		if !ok || !filepath.IsAbs(str) || filepath.Clean(str) != str {
			return s, bad("wake_file", "must be an absolute, clean path, or null")
		}
		s.WakeFile = &str
	}
	if v, ok := m["retain_days"]; ok && v != nil {
		n, err := integer("retain_days", v, 0, 36500)
		if err != nil {
			return s, err
		}
		s.RetainDays = &n
	}
	if v, ok := m["presence"]; ok {
		if s.Presence, err = boolean("presence", v); err != nil {
			return s, err
		}
	}
	if v, ok := m["read_receipts"]; ok {
		if s.ReadReceipts, err = enum("read_receipts", v, "on-read", "on-keep", "off"); err != nil {
			return s, err
		}
	}
	if v, ok := m["send"]; ok {
		obj, ok := v.(map[string]any)
		if !ok {
			return s, bad("send", "must be an object")
		}
		for _, k := range sortedKeys(obj) {
			if !sendKeys[k] {
				return s, bad("send."+k, "unknown key")
			}
		}
		if v, ok := obj["first_contact"]; ok {
			if s.Send.FirstContact, err = enum("send.first_contact", v, "refuse", "allow"); err != nil {
				return s, err
			}
		}
		ints := []struct {
			key      string
			dst      *int
			min, max int
		}{
			{"per_hour", &s.Send.PerHour, 1, 100000},
			{"per_minute", &s.Send.PerMinute, 1, 10000},
			{"same_text_chats", &s.Send.SameTextChats, 1, 10000},
			{"max_file_mb", &s.Send.MaxFileMB, 1, 2000},
		}
		for _, f := range ints {
			if v, ok := obj[f.key]; ok {
				if *f.dst, err = integer("send."+f.key, v, f.min, f.max); err != nil {
					return s, err
				}
			}
		}
	}
	return s, nil
}

func enum(key string, v any, allowed ...string) (string, error) {
	str, ok := v.(string)
	if ok {
		for _, a := range allowed {
			if str == a {
				return str, nil
			}
		}
	}
	return "", bad(key, "must be one of %v", allowed)
}

func boolean(key string, v any) (bool, error) {
	b, ok := v.(bool)
	if !ok {
		return false, bad(key, "must be true or false")
	}
	return b, nil
}

func integer(key string, v any, min, max int) (int, error) {
	num, ok := v.(json.Number)
	if ok {
		if n, err := num.Int64(); err == nil && n >= int64(min) && n <= int64(max) {
			return int(n), nil
		}
	}
	return 0, bad(key, "must be a whole number from %d to %d", min, max)
}

// Marshal returns the file form: indented JSON, with wake_file and retain_days omitted when unset.
func (s Settings) Marshal() []byte {
	m := s.toMap()
	if s.WakeFile == nil {
		delete(m, "wake_file")
	}
	if s.RetainDays == nil {
		delete(m, "retain_days")
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return append(b, '\n')
}

func (s Settings) toMap() map[string]any {
	b, _ := json.Marshal(s)
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	_ = dec.Decode(&m)
	return m
}

// Patch applies a JSON merge patch (RFC 7386) to s and validates the result as a whole: objects
// merge, null removes a key (restoring its default), anything else replaces.
func Patch(s Settings, patch []byte) (Settings, error) {
	p, err := decodeObject(patch, "")
	if err != nil {
		return s, err
	}
	for _, k := range sortedKeys(p) {
		if !topKeys[k] {
			return s, bad(k, "unknown key")
		}
	}
	merged := mergePatch(s.toMap(), p).(map[string]any)
	return fromMap(merged)
}

func mergePatch(target any, patch any) any {
	pm, ok := patch.(map[string]any)
	if !ok {
		return patch
	}
	tm, ok := target.(map[string]any)
	if !ok {
		tm = map[string]any{}
	}
	out := map[string]any{}
	for k, v := range tm {
		out[k] = v
	}
	for k, v := range pm {
		if v == nil {
			delete(out, k)
			continue
		}
		out[k] = mergePatch(out[k], v)
	}
	return out
}

// Equal reports whether two settings are the same.
func Equal(a, b Settings) bool { return reflect.DeepEqual(a.toMap(), b.toMap()) }

// Load reads and validates a settings file.
func Load(path string) (Settings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Settings{}, err
	}
	s, err := Parse(data)
	if err != nil {
		return s, fmt.Errorf("%s: %w", path, err)
	}
	return s, nil
}

// Write replaces path atomically: a temporary file in the same directory, synced, then renamed.
func Write(path string, s Settings) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".settings-*.json")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(s.Marshal()); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
