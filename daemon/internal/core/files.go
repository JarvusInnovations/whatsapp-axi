package core

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png" // decodes PNG for previews
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
)

// extTypes are MIME types for common extensions, so detection does not depend on the host's
// mime.types file.
var extTypes = map[string]string{
	".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
	".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
	".mp4": "video/mp4", ".3gp": "video/3gpp", ".mov": "video/quicktime", ".webm": "video/webm",
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
	".amr": "audio/amr", ".wav": "audio/wav",
	".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip",
	".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt":  "application/vnd.oasis.opendocument.text", ".rtf": "application/rtf",
}

const genericType = "application/octet-stream"

// DetectMIME picks a file's MIME type from its extension and its content (specs/sending.md):
// the extension's type when it is known, else the type sniffed from the content when that is
// specific, else the generic binary type.
func DetectMIME(name string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(name))
	if t, ok := extTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return strings.TrimSpace(strings.SplitN(t, ";", 2)[0])
	}
	sniffed := strings.SplitN(http.DetectContentType(data), ";", 2)[0]
	if sniffed != genericType && sniffed != "text/plain" {
		return sniffed
	}
	if sniffed == "text/plain" && ext == "" {
		return "text/plain"
	}
	return genericType
}

// SendType picks how a file goes out: image, video or audio for the types WhatsApp plays inline,
// document for everything else.
func SendType(mimeType string) string {
	switch {
	case mimeType == "image/jpeg" || mimeType == "image/png":
		return "image"
	case mimeType == "video/mp4" || mimeType == "video/3gpp":
		return "video"
	case strings.HasPrefix(mimeType, "audio/"):
		return "audio"
	}
	return "document"
}

// extFor is the extension of a downloaded file, from its MIME type.
func extFor(mimeType string) string {
	base := strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0])
	best := ""
	for ext, t := range extTypes {
		if t == base && (best == "" || ext < best) {
			best = ext
		}
	}
	if best != "" {
		return best
	}
	if exts, _ := mime.ExtensionsByType(base); len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9.-]+`)

// mediaFileName builds the name a download is stored under from the chat and message id, never
// from a name the sender chose.
func mediaFileName(chat, id, mimeType string) string {
	return unsafeName.ReplaceAllString(chat, "_") + "_" + unsafeName.ReplaceAllString(id, "_") + extFor(mimeType)
}

// Preview makes a small JPEG preview of an image, and returns its full size. ok is false when the
// image cannot be decoded; it then goes out without a preview.
func Preview(data []byte) (thumb []byte, width, height int, ok bool) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, false
	}
	b := src.Bounds()
	width, height = b.Dx(), b.Dy()
	if width == 0 || height == 0 {
		return nil, 0, 0, false
	}
	const max = 72
	tw, th := max, height*max/width
	if height > width {
		th, tw = max, width*max/height
	}
	if tw < 1 {
		tw = 1
	}
	if th < 1 {
		th = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	for y := 0; y < th; y++ {
		for x := 0; x < tw; x++ {
			// Box-average the source pixels under this one.
			x0, x1 := b.Min.X+x*width/tw, b.Min.X+(x+1)*width/tw
			y0, y1 := b.Min.Y+y*height/th, b.Min.Y+(y+1)*height/th
			if x1 <= x0 {
				x1 = x0 + 1
			}
			if y1 <= y0 {
				y1 = y0 + 1
			}
			var r, g, bl, n uint64
			stepX, stepY := (x1-x0)/8+1, (y1-y0)/8+1
			for sy := y0; sy < y1; sy += stepY {
				for sx := x0; sx < x1; sx += stepX {
					cr, cg, cb, _ := src.At(sx, sy).RGBA()
					r, g, bl, n = r+uint64(cr), g+uint64(cg), bl+uint64(cb), n+1
				}
			}
			dst.Set(x, y, color.RGBA64{uint16(r / n), uint16(g / n), uint16(bl / n), 0xffff})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 60}); err != nil {
		return nil, 0, 0, false
	}
	return buf.Bytes(), width, height, true
}
