package identity

import "testing"

func TestNonAD(t *testing.T) {
	cases := map[string]string{
		"15550100001@s.whatsapp.net":      "15550100001@s.whatsapp.net",
		"15550100001:12@s.whatsapp.net":   "15550100001@s.whatsapp.net",
		"15550100001.0:12@s.whatsapp.net": "15550100001@s.whatsapp.net",
		"100000000000001:4@lid":           "100000000000001@lid",
		"120363000000000001@g.us":         "120363000000000001@g.us",
		"nonsense":                        "",
		"@lid":                            "",
	}
	for in, want := range cases {
		if got := NonAD(in); got != want {
			t.Errorf("NonAD(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsMe(t *testing.T) {
	both := Own{PN: "15550100000@s.whatsapp.net", LID: "100000000000000@lid"}
	if !both.IsMe("15550100000@s.whatsapp.net") || !both.IsMe("15550100000:2@s.whatsapp.net") {
		t.Error("by phone-number id")
	}
	if !both.IsMe("100000000000000@lid") || !both.IsMe("100000000000000:7@lid") {
		t.Error("by hidden id")
	}
	if both.IsMe("15550100001@s.whatsapp.net") || both.IsMe("") {
		t.Error("someone else is not me")
	}
	pnOnly := Own{PN: "15550100000@s.whatsapp.net"}
	if !pnOnly.IsMe("15550100000@s.whatsapp.net") || pnOnly.IsMe("100000000000000@lid") {
		t.Error("with the hidden id unknown")
	}
	// The same digits on another server are a different id.
	if both.IsMe("15550100000@lid") {
		t.Error("nothing is inferred from digits")
	}
}

func TestOperators(t *testing.T) {
	ops := []string{"+15550100001", "100000000000002@lid"}
	if !IsOperator("100000000000001@lid", "15550100001@s.whatsapp.net", ops) {
		t.Error("by phone number through the map")
	}
	if !IsOperator("100000000000002@lid", "", ops) {
		t.Error("by hidden id directly")
	}
	if IsOperator("100000000000001@lid", "", ops) {
		t.Error("fails closed when the map has no entry")
	}
	if !IsOperator("", "15550100001@s.whatsapp.net", ops) {
		t.Error("by phone-number id alone")
	}
	if IsOperator("", "15550100009@s.whatsapp.net", ops) {
		t.Error("not listed")
	}
}

func TestForms(t *testing.T) {
	if PhoneOf("15550100001@s.whatsapp.net") != "+15550100001" || PNOfPhone("+15550100001") != "15550100001@s.whatsapp.net" {
		t.Error("phone conversion")
	}
	if PhoneOf("100000000000001@lid") != "" || PNOfPhone("15550100001") != "" {
		t.Error("bad forms convert to empty")
	}
	if c, id := SplitRef("120363000000000001@g.us/3EB0AA"); c != "120363000000000001@g.us" || id != "3EB0AA" {
		t.Error("chat/id ref")
	}
	if c, id := SplitRef("3EB0AA"); c != "" || id != "3EB0AA" {
		t.Error("bare ref")
	}
}
