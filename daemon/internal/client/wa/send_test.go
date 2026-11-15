package wa

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

func TestBuildTextMessages(t *testing.T) {
	m := BuildMessage(client.OutMessage{ID: "3EB0X", Chat: group.String(), Text: "plain"}, nil)
	if m.GetConversation() != "plain" || m.GetExtendedTextMessage() != nil {
		t.Fatalf("%v", m)
	}
	m = BuildMessage(client.OutMessage{Chat: group.String(), Text: "hi @100000000000001", Mentions: []string{samLID.String()},
		Reply: &client.Quoted{ID: "3EB0PARENT", Sender: samLID.String() + "", Text: "the parent"}}, nil)
	x := m.GetExtendedTextMessage()
	ci := x.GetContextInfo()
	if x.GetText() != "hi @100000000000001" || ci.GetStanzaID() != "3EB0PARENT" || ci.GetParticipant() != samLID.String() ||
		ci.GetQuotedMessage().GetConversation() != "the parent" || len(ci.GetMentionedJID()) != 1 {
		t.Fatalf("%v", m)
	}
	// A parent sender with a device suffix is quoted device-free.
	m = BuildMessage(client.OutMessage{Text: "x", Reply: &client.Quoted{ID: "3EB0P", Sender: "15550100001:3@s.whatsapp.net"}}, nil)
	if p := m.GetExtendedTextMessage().GetContextInfo().GetParticipant(); p != "15550100001@s.whatsapp.net" {
		t.Fatal(p)
	}
}

func TestBuildFileMessages(t *testing.T) {
	up := &whatsmeow.UploadResponse{URL: "https://example.invalid/x", DirectPath: "/v/t62/x?oh=tok", MediaKey: []byte("k"), FileEncSHA256: []byte("e"), FileSHA256: []byte("s"), FileLength: 9}
	doc := BuildMessage(client.OutMessage{Text: "the report", File: &client.OutFile{Type: "document", MIME: "application/pdf", Name: "report.pdf"}}, up).GetDocumentMessage()
	if doc.GetFileName() != "report.pdf" || doc.GetTitle() != "report.pdf" || doc.GetMimetype() != "application/pdf" || doc.GetCaption() != "the report" ||
		doc.GetDirectPath() != "/v/t62/x?oh=tok" || doc.GetFileLength() != 9 || doc.GetJPEGThumbnail() != nil {
		t.Fatalf("%v", doc)
	}
	img := BuildMessage(client.OutMessage{File: &client.OutFile{Type: "image", MIME: "image/png", Thumbnail: []byte{0xff, 0xd8}, Width: 300, Height: 200},
		Reply: &client.Quoted{ID: "3EB0P", Text: "q"}}, up).GetImageMessage()
	if !bytes.Equal(img.GetJPEGThumbnail(), []byte{0xff, 0xd8}) || img.GetWidth() != 300 || img.Caption != nil || img.GetContextInfo().GetStanzaID() != "3EB0P" {
		t.Fatalf("%v", img)
	}
	if v := BuildMessage(client.OutMessage{File: &client.OutFile{Type: "video", MIME: "video/mp4"}}, up).GetVideoMessage(); v.GetMimetype() != "video/mp4" || v.GetJPEGThumbnail() != nil {
		t.Fatalf("%v", v)
	}
	if a := BuildMessage(client.OutMessage{File: &client.OutFile{Type: "audio", MIME: "audio/ogg"}}, up).GetAudioMessage(); a.GetMimetype() != "audio/ogg" {
		t.Fatalf("%v", a)
	}
}

func TestDownloadAndExpiry(t *testing.T) {
	var logw bytes.Buffer
	a := newAdapter(t, &logw)
	if err := a.Start(context.Background(), func(client.Event) {}); err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	// A descriptor without a path or key is not downloadable, before any connection is needed.
	if _, err := a.Download(context.Background(), &client.Media{Keys: []byte(`{"type":"image"}`)}); err != client.ErrNotDownloadable {
		t.Fatal(err)
	}
	if _, err := a.Download(context.Background(), &client.Media{Keys: []byte(`{"type":"image","direct_path":"/x","media_key":"aw=="}`)}); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if !IsExpired(whatsmeow.ErrMediaDownloadFailedWith404) || !IsExpired(whatsmeow.ErrMediaDownloadFailedWith410) || IsExpired(whatsmeow.ErrMediaDownloadFailedWith403) {
		t.Fatal("expiry mapping")
	}
	if _, err := a.Send(context.Background(), client.OutMessage{Chat: group.String(), Text: "x"}); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if _, err := a.React(context.Background(), group.String(), "", "3EB0X", "x"); err != client.ErrNotConnected {
		t.Fatal(err)
	}
	if id := a.NewMessageID(); !strings.HasPrefix(id, "3EB0") {
		t.Fatal(id)
	}
}
