package wa

import (
	"encoding/json"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/JarvusInnovations/whatsapp-axi/daemon/internal/client"
)

// MediaKeys is the key material and download path of a media descriptor, carried through the
// daemon as opaque client.Media.Keys. The direct path is kept exactly as it arrived, query
// string and all.
type MediaKeys struct {
	Type          string `json:"type"` // image, video, audio, document, sticker
	DirectPath    string `json:"direct_path"`
	URL           string `json:"url,omitempty"`
	MediaKey      []byte `json:"media_key"`
	FileEncSHA256 []byte `json:"file_enc_sha256"`
	FileSHA256    []byte `json:"file_sha256"`
	FileLength    uint64 `json:"file_length"`
}

// DecodeKeys reads client.Media.Keys written by this package.
func DecodeKeys(b []byte) (MediaKeys, error) {
	var k MediaKeys
	if len(b) == 0 {
		return k, fmt.Errorf("no media keys")
	}
	err := json.Unmarshal(b, &k)
	return k, err
}

// Translate turns one library event into the daemon's events. It drops history, protocol
// traffic, newsletters, undecryptable messages and every event the daemon has no use for.
// own is the account's own ids.
func Translate(raw any, own client.Own) []client.Event {
	switch e := raw.(type) {
	case *events.Message:
		if m := translateMessage(e); m != nil {
			out := []client.Event{m}
			if e.Info.IsFromMe && e.Info.Sender.Device == 0 {
				out = append(out, client.PhoneActivity{Time: timeOr(e.Info.Timestamp)})
			}
			return out
		}
	case *events.Receipt:
		// Receipts the account's own phone sends (it read or played something) show the phone
		// is in use.
		if e.IsFromMe && e.Sender.Device == 0 {
			return []client.Event{client.PhoneActivity{Time: timeOr(e.Timestamp)}}
		}
	case *events.Connected:
		return []client.Event{client.StateChange{State: "connected"}}
	case *events.Disconnected:
		return []client.Event{client.StateChange{State: "connecting", Reason: "connection lost; reconnecting"}}
	case *events.LoggedOut:
		return []client.Event{client.StateChange{State: "logged_out", Reason: loggedOutReason(e)}}
	case *events.TemporaryBan:
		return []client.Event{client.StateChange{State: "suspended", Reason: banReason(e)}}
	case *events.ClientOutdated:
		return []client.Event{client.StateChange{State: "outdated", Reason: "WhatsApp rejected the client as too old (405)"}}
	case *events.StreamReplaced:
		return []client.Event{client.StateChange{State: "connecting", Reason: "another client connected with this session; restart the daemon after stopping the other one"}}
	case *events.ConnectFailure:
		return []client.Event{client.StateChange{State: "connecting", Reason: fmt.Sprintf("connect failure %d", int(e.Reason))}}
	}
	return nil
}

func timeOr(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now()
	}
	return t
}

func loggedOutReason(e *events.LoggedOut) string {
	if !e.OnConnect {
		return "the device was removed on the phone"
	}
	switch e.Reason {
	case events.ConnectFailureLoggedOut:
		return "logged out (401): removed on the phone, or the phone unused too long"
	case events.ConnectFailureMainDeviceGone:
		return "logged out (403): the phone's account is gone or locked, possibly banned"
	case events.ConnectFailureUnknownLogout:
		return "logged out (406): possibly banned"
	}
	return fmt.Sprintf("logged out (%d)", int(e.Reason))
}

func banReason(e *events.TemporaryBan) string {
	r := fmt.Sprintf("temporarily banned (%d)", int(e.Code))
	if e.Expire > 0 {
		r += fmt.Sprintf("; expires at %s", time.Now().Add(e.Expire).UTC().Format(time.RFC3339))
	}
	return r
}

func chatType(chat types.JID) client.ChatType {
	switch {
	case chat == types.StatusBroadcastJID:
		return client.ChatStatus
	case chat.Server == types.GroupServer:
		return client.ChatGroup
	case chat.Server == types.BroadcastServer:
		return client.ChatBroadcast
	case chat.Server == types.NewsletterServer:
		return client.ChatNewsletter
	case chat.Server == types.DefaultUserServer, chat.Server == types.HiddenUserServer:
		return client.ChatDirect
	}
	return client.ChatUnknown
}

func jidString(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	return j.String()
}

func translateMessage(e *events.Message) *client.Message {
	if e == nil || e.Message == nil || e.SourceWebMsg != nil {
		return nil // history, or nothing to read
	}
	info := e.Info
	ct := chatType(info.Chat)
	if ct == client.ChatNewsletter {
		return nil
	}
	m := &client.Message{
		Chat:      info.Chat.ToNonAD().String(),
		ChatType:  ct,
		ID:        info.ID,
		Sender:    jidString(info.Sender),
		SenderAlt: jidString(info.SenderAlt),
		FromMe:    info.IsFromMe,
		Time:      info.Timestamp,
		PushName:  info.PushName,
	}
	if ct == client.ChatDirect {
		alt := info.SenderAlt
		if info.IsFromMe {
			alt = info.RecipientAlt
		}
		if !alt.IsEmpty() {
			m.ChatAlt = alt.ToNonAD().String()
		}
	}
	msg := e.Message

	if pm := msg.GetProtocolMessage(); pm != nil {
		switch {
		case e.IsEdit || pm.GetType() == waE2E.ProtocolMessage_MESSAGE_EDIT:
			if pm.GetKey().GetID() == "" || pm.GetEditedMessage() == nil {
				return nil
			}
			m.Kind = client.KindEdit
			m.TargetID = pm.GetKey().GetID()
			if !content(m, pm.GetEditedMessage(), e) {
				// An edit with content the daemon does not read still updates nothing useful.
				return nil
			}
			return m
		case pm.GetType() == waE2E.ProtocolMessage_REVOKE:
			if pm.GetKey().GetID() == "" {
				return nil
			}
			m.Kind = client.KindRevoke
			m.TargetID = pm.GetKey().GetID()
			return m
		default:
			return nil // history notifications, key shares, ephemeral settings and the rest
		}
	}
	if r := msg.GetReactionMessage(); r != nil {
		if r.GetKey().GetID() == "" {
			return nil
		}
		m.Kind = client.KindReaction
		m.TargetID = r.GetKey().GetID()
		m.Emoji = r.GetText()
		return m
	}
	if msg.GetEncReactionMessage() != nil || msg.GetEncCommentMessage() != nil {
		m.Kind = client.KindEncrypted
		if ct == client.ChatGroup {
			m.ChatType = client.ChatCommunityAnnounce
		}
		return m
	}
	m.Kind = client.KindMessage
	if !content(m, msg, e) {
		return nil // protocol traffic (sender keys, poll votes, receipts of keys) or unknown
	}
	return m
}

// mediaPart is what every media message type has.
type mediaPart interface {
	GetMimetype() string
	GetFileLength() uint64
	GetDirectPath() string
	GetURL() string
	GetMediaKey() []byte
	GetFileSHA256() []byte
	GetFileEncSHA256() []byte
	GetContextInfo() *waE2E.ContextInfo
}

func descriptor(typ string, p mediaPart, name, caption string, viewOnce bool) *client.Media {
	keys, _ := json.Marshal(MediaKeys{
		Type:          typ,
		DirectPath:    p.GetDirectPath(),
		URL:           p.GetURL(),
		MediaKey:      p.GetMediaKey(),
		FileEncSHA256: p.GetFileEncSHA256(),
		FileSHA256:    p.GetFileSHA256(),
		FileLength:    p.GetFileLength(),
	})
	return &client.Media{
		Type:     typ,
		MIME:     p.GetMimetype(),
		Name:     name,
		Size:     int64(p.GetFileLength()),
		Caption:  caption,
		ViewOnce: viewOnce,
		Keys:     keys,
	}
}

// parts reads the text, media descriptor and context of a message, whichever type it is. ok is
// false for a message with no content the daemon reads.
func parts(msg *waE2E.Message, viewOnce bool) (text string, media *client.Media, ci *waE2E.ContextInfo, ok bool) {
	switch {
	case msg.Conversation != nil:
		return msg.GetConversation(), nil, nil, true
	case msg.GetExtendedTextMessage() != nil:
		x := msg.GetExtendedTextMessage()
		return x.GetText(), nil, x.GetContextInfo(), true
	case msg.GetImageMessage() != nil:
		x := msg.GetImageMessage()
		return "", descriptor("image", x, "", x.GetCaption(), viewOnce || x.GetViewOnce()), x.GetContextInfo(), true
	case msg.GetVideoMessage() != nil:
		x := msg.GetVideoMessage()
		return "", descriptor("video", x, "", x.GetCaption(), viewOnce || x.GetViewOnce()), x.GetContextInfo(), true
	case msg.GetPtvMessage() != nil:
		x := msg.GetPtvMessage()
		return "", descriptor("video", x, "", x.GetCaption(), viewOnce || x.GetViewOnce()), x.GetContextInfo(), true
	case msg.GetAudioMessage() != nil:
		x := msg.GetAudioMessage()
		return "", descriptor("audio", x, "", "", viewOnce || x.GetViewOnce()), x.GetContextInfo(), true
	case msg.GetDocumentMessage() != nil:
		x := msg.GetDocumentMessage()
		name := x.GetFileName()
		if name == "" {
			name = x.GetTitle()
		}
		return "", descriptor("document", x, name, x.GetCaption(), viewOnce), x.GetContextInfo(), true
	case msg.GetStickerMessage() != nil:
		x := msg.GetStickerMessage()
		return "", descriptor("sticker", x, "", "", viewOnce), x.GetContextInfo(), true
	case msg.GetLocationMessage() != nil:
		x := msg.GetLocationMessage()
		return x.GetComment(), nil, x.GetContextInfo(), true
	case msg.GetLiveLocationMessage() != nil:
		x := msg.GetLiveLocationMessage()
		return x.GetCaption(), nil, x.GetContextInfo(), true
	case msg.GetContactMessage() != nil:
		x := msg.GetContactMessage()
		return x.GetDisplayName(), nil, x.GetContextInfo(), true
	case msg.GetPollCreationMessage() != nil:
		x := msg.GetPollCreationMessage()
		return x.GetName(), nil, x.GetContextInfo(), true
	case msg.GetPollCreationMessageV3() != nil:
		x := msg.GetPollCreationMessageV3()
		return x.GetName(), nil, x.GetContextInfo(), true
	case msg.GetGroupMentionedMessage().GetMessage() != nil:
		return parts(msg.GetGroupMentionedMessage().GetMessage(), viewOnce)
	}
	return "", nil, nil, false
}

// content fills the content fields of m from msg. A caption goes in Media.Caption.
func content(m *client.Message, msg *waE2E.Message, e *events.Message) bool {
	text, media, ci, ok := parts(msg, e.IsViewOnce)
	if !ok {
		return false
	}
	m.Text = text
	m.Media = media
	if ci == nil {
		return true
	}
	m.Mentions = append([]string(nil), ci.GetMentionedJID()...)
	m.Ephemeral = ci.GetExpiration()
	if id := ci.GetStanzaID(); id != "" {
		q := &client.Quoted{ID: id, Sender: ci.GetParticipant(), Chat: ci.GetRemoteJID()}
		if qm := ci.GetQuotedMessage(); qm != nil {
			qt, qmedia, _, _ := parts(qm, false)
			q.Text = qt
			q.Media = qmedia
		}
		m.ReplyTo = q
	}
	return true
}
