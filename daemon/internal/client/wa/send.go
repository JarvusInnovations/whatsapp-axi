package wa

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

func (c *Client) NewMessageID() string {
	wa := c.lib()
	if wa == nil {
		return ""
	}
	return string(wa.GenerateMessageID())
}

var mediaTypes = map[string]whatsmeow.MediaType{
	"image":    whatsmeow.MediaImage,
	"video":    whatsmeow.MediaVideo,
	"audio":    whatsmeow.MediaAudio,
	"document": whatsmeow.MediaDocument,
	"sticker":  whatsmeow.MediaImage,
}

// contextInfo carries a reply and mentions. The quote embeds the parent's text only, never its
// media or keys (plans/sending.md "Risks").
func contextInfo(m client.OutMessage) *waE2E.ContextInfo {
	if m.Reply == nil && len(m.Mentions) == 0 {
		return nil
	}
	ci := &waE2E.ContextInfo{}
	if len(m.Mentions) > 0 {
		ci.MentionedJID = append([]string(nil), m.Mentions...)
	}
	if q := m.Reply; q != nil {
		ci.StanzaID = proto.String(q.ID)
		if q.Sender != "" {
			if j, err := types.ParseJID(q.Sender); err == nil {
				ci.Participant = proto.String(j.ToNonAD().String())
			}
		}
		ci.QuotedMessage = &waE2E.Message{Conversation: proto.String(q.Text)}
	}
	return ci
}

// BuildMessage builds the library message for a send. upload is the upload of m.File, if any.
// It is exported so tests can check the shape without a connection.
func BuildMessage(m client.OutMessage, up *whatsmeow.UploadResponse) *waE2E.Message {
	ci := contextInfo(m)
	if m.File == nil {
		if ci == nil {
			return &waE2E.Message{Conversation: proto.String(m.Text)}
		}
		return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(m.Text), ContextInfo: ci}}
	}
	f := m.File
	var caption *string
	if m.Text != "" {
		caption = proto.String(m.Text)
	}
	switch f.Type {
	case "image":
		x := &waE2E.ImageMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(f.MIME), Caption: caption, ContextInfo: ci,
		}
		if len(f.Thumbnail) > 0 {
			x.JPEGThumbnail = f.Thumbnail
		}
		if f.Width > 0 && f.Height > 0 {
			x.Width, x.Height = proto.Uint32(uint32(f.Width)), proto.Uint32(uint32(f.Height))
		}
		return &waE2E.Message{ImageMessage: x}
	case "video":
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(f.MIME), Caption: caption, ContextInfo: ci,
		}}
	case "audio":
		return &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(f.MIME), ContextInfo: ci,
		}}
	default:
		return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(f.MIME), FileName: proto.String(f.Name), Title: proto.String(f.Name),
			Caption: caption, ContextInfo: ci,
		}}
	}
}

func (c *Client) Send(ctx context.Context, m client.OutMessage) (client.SendResult, error) {
	wa, err := c.connected()
	if err != nil {
		return client.SendResult{}, err
	}
	to, err := types.ParseJID(m.Chat)
	if err != nil {
		return client.SendResult{}, err
	}
	var up *whatsmeow.UploadResponse
	var media *client.Media
	if m.File != nil {
		mt, ok := mediaTypes[m.File.Type]
		if !ok {
			return client.SendResult{}, fmt.Errorf("unknown media type %q", m.File.Type)
		}
		r, err := wa.Upload(ctx, m.File.Data, mt)
		if err != nil {
			return client.SendResult{}, fmt.Errorf("upload: %w", err)
		}
		up = &r
		keys, _ := json.Marshal(MediaKeys{
			Type: m.File.Type, DirectPath: r.DirectPath, URL: r.URL, MediaKey: r.MediaKey,
			FileEncSHA256: r.FileEncSHA256, FileSHA256: r.FileSHA256, FileLength: r.FileLength,
		})
		media = &client.Media{Type: m.File.Type, MIME: m.File.MIME, Name: m.File.Name, Size: int64(r.FileLength), Caption: m.Text, Keys: keys}
	}
	resp, err := wa.SendMessage(ctx, to, BuildMessage(m, up), whatsmeow.SendRequestExtra{ID: types.MessageID(m.ID)})
	if err != nil {
		return client.SendResult{}, sendErr(err)
	}
	return client.SendResult{Chat: nonADString(resp.Chat), Sender: nonADString(resp.Sender), Time: resp.Timestamp, Media: media}, nil
}

// sendErr marks the errors after which a message may have gone out: no answer to it in time, or
// the wait cut short. Everything else means WhatsApp did not take it.
func sendErr(err error) error {
	if errors.Is(err, whatsmeow.ErrMessageTimedOut) || errors.Is(err, whatsmeow.ErrIQTimedOut) ||
		errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: %w", client.ErrOutcomeUnknown, err)
	}
	return err
}

func nonADString(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	return j.ToNonAD().String()
}

func (c *Client) React(ctx context.Context, chat, sender, id, emoji string) (client.SendResult, error) {
	wa, err := c.connected()
	if err != nil {
		return client.SendResult{}, err
	}
	cj, err := types.ParseJID(chat)
	if err != nil {
		return client.SendResult{}, err
	}
	sj := types.EmptyJID
	if sender != "" {
		if sj, err = types.ParseJID(sender); err != nil {
			return client.SendResult{}, err
		}
	}
	resp, err := wa.SendMessage(ctx, cj, wa.BuildReaction(cj, sj, types.MessageID(id), emoji))
	if err != nil {
		return client.SendResult{}, sendErr(err)
	}
	return client.SendResult{Chat: nonADString(resp.Chat), Sender: nonADString(resp.Sender), Time: resp.Timestamp}, nil
}

// Download fetches a file by its stored direct path, used exactly as it arrived.
func (c *Client) Download(ctx context.Context, m *client.Media) ([]byte, error) {
	k, err := DecodeKeys(m.Keys)
	if err != nil || k.DirectPath == "" || len(k.MediaKey) == 0 {
		return nil, client.ErrNotDownloadable
	}
	mt, ok := mediaTypes[k.Type]
	if !ok {
		return nil, client.ErrNotDownloadable
	}
	wa, err := c.connected()
	if err != nil {
		return nil, err
	}
	data, err := wa.DownloadMediaWithPath(ctx, k.DirectPath, k.FileEncSHA256, k.FileSHA256, k.MediaKey, mt, "", false)
	if IsExpired(err) {
		return nil, client.ErrNotDownloadable
	}
	return data, err
}

// IsExpired reports whether a download error means the server copy is gone.
func IsExpired(err error) bool {
	return errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) || errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410)
}
