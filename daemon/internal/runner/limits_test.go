package runner

import (
	"testing"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/core"
)

// TestListsStateTheirSize: chats, groups, messages and events each say how many there are in all,
// so a cut list is never silently partial (specs/cli.md "Reading").
func TestListsStateTheirSize(t *testing.T) {
	e := newEnv(t)
	e.init()
	d := e.start(startOpts{})
	d.fake.SetGroup(group, client.GroupInfo{Name: "A group"})
	d.fake.SetGroup(group2, client.GroupInfo{Name: "B group"})
	for i := 0; i < 3; i++ {
		d.emit(msg("@Example hello", mention))
	}
	d.emit(msg("@Example other", mention, func(m *client.Message) { m.Chat = group2 }))

	var chats struct {
		Chats []core.ChatSummary `json:"chats"`
		Total int                `json:"total"`
	}
	d.get("/v1/chats?limit=1", &chats)
	if len(chats.Chats) != 1 || chats.Total != 2 {
		t.Fatalf("chats %d of %d", len(chats.Chats), chats.Total)
	}
	d.get("/v1/chats", &chats)
	if len(chats.Chats) != 2 || chats.Total != 2 {
		t.Fatalf("chats %d of %d", len(chats.Chats), chats.Total)
	}
	var groups struct {
		Groups []core.GroupSummary `json:"groups"`
		Total  int                 `json:"total"`
	}
	d.get("/v1/groups?limit=1", &groups)
	if len(groups.Groups) != 1 || groups.Total != 2 || groups.Groups[0].Name != "A group" {
		t.Fatalf("groups %+v of %d", groups.Groups, groups.Total)
	}
	var page core.MessagesPage
	d.get("/v1/messages?chat="+group+"&limit=2", &page)
	if len(page.Messages) != 2 || page.Total != 3 || !page.More {
		t.Fatalf("messages %d of %d", len(page.Messages), page.Total)
	}
	d.get("/v1/messages?chat="+group+"&limit=2&before="+page.Messages[0].ID, &page)
	if len(page.Messages) != 1 || page.Total != 1 {
		t.Fatalf("messages before %d of %d", len(page.Messages), page.Total)
	}
	var evs struct {
		Events []core.Event `json:"events"`
		Total  int64        `json:"total"`
	}
	d.get("/v1/events?limit=2&kind=message", &evs)
	if len(evs.Events) != 2 || evs.Total != 4 {
		t.Fatalf("events %d of %d", len(evs.Events), evs.Total)
	}
	d.get("/v1/events?after=0&limit=1&chat="+group2, &evs)
	if len(evs.Events) != 1 || evs.Total != 1 {
		t.Fatalf("events in a chat %d of %d", len(evs.Events), evs.Total)
	}
	d.wantError("GET", "/v1/chats?limit=0", nil, 400, "VALIDATION_ERROR")
	d.wantError("GET", "/v1/groups?limit=x", nil, 400, "VALIDATION_ERROR")
	d.wantError("GET", "/v1/chats?nope=1", nil, 400, "VALIDATION_ERROR")
}
