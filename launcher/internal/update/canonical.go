package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const (
	maxSafeInteger    = 1<<53 - 1
	maxCanonicalDepth = 64
)

var (
	backslash = string(rune(92))
	quoteRune = rune(34)
)

func writeEscaped(builder *strings.Builder, r rune) {
	switch r {
	case quoteRune:
		builder.WriteString(backslash)
		builder.WriteString(string(quoteRune))
	case rune(92):
		builder.WriteString(backslash)
		builder.WriteString(backslash)
	case '\b':
		builder.WriteString(backslash + "b")
	case '\f':
		builder.WriteString(backslash + "f")
	case '\n':
		builder.WriteString(backslash + "n")
	case '\r':
		builder.WriteString(backslash + "r")
	case '\t':
		builder.WriteString(backslash + "t")
	default:
		if r < 0x20 {
			builder.WriteString(backslash)
			builder.WriteString(fmt.Sprintf("u%04x", r))
			return
		}
		builder.WriteRune(r)
	}
}

func quoteJSONString(builder *strings.Builder, value string) {
	builder.WriteRune(quoteRune)
	for _, r := range value {
		writeEscaped(builder, r)
	}
	builder.WriteRune(quoteRune)
}

func utf16Less(left, right string) bool {
	a := utf16.Encode([]rune(left))
	b := utf16.Encode([]rune(right))
	for index := 0; index < len(a) && index < len(b); index++ {
		if a[index] != b[index] {
			return a[index] < b[index]
		}
	}
	return len(a) < len(b)
}

func canonicalNumber(value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", errors.New("canonical JSON accepts only finite numbers")
	}
	if value != math.Trunc(value) {
		return "", errors.New("canonical JSON accepts only integers")
	}
	if math.Abs(value) > maxSafeInteger {
		return "", errors.New("canonical JSON accepts only safe integers")
	}
	if value == 0 {
		return "0", nil
	}
	return strconv.FormatFloat(value, 'f', -1, 64), nil
}

func writeCanonical(builder *strings.Builder, value any, depth int) error {
	if depth > maxCanonicalDepth {
		return errors.New("canonical JSON is nested too deeply")
	}
	switch typed := value.(type) {
	case nil:
		builder.WriteString("null")
	case bool:
		builder.WriteString(strconv.FormatBool(typed))
	case string:
		quoteJSONString(builder, typed)
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return err
		}
		text, err := canonicalNumber(number)
		if err != nil {
			return err
		}
		builder.WriteString(text)
	case float64:
		text, err := canonicalNumber(typed)
		if err != nil {
			return err
		}
		builder.WriteString(text)
	case int:
		builder.WriteString(strconv.Itoa(typed))
	case int64:
		builder.WriteString(strconv.FormatInt(typed, 10))
	case []any:
		builder.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}
			if err := writeCanonical(builder, entry, depth+1); err != nil {
				return err
			}
		}
		builder.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool { return utf16Less(keys[i], keys[j]) })
		builder.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				builder.WriteByte(',')
			}
			quoteJSONString(builder, key)
			builder.WriteByte(':')
			if err := writeCanonical(builder, typed[key], depth+1); err != nil {
				return err
			}
		}
		builder.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %T", value)
	}
	return nil
}

func CanonicalizeJSON(value any) (string, error) {
	var builder strings.Builder
	if err := writeCanonical(&builder, value, 0); err != nil {
		return "", err
	}
	return builder.String(), nil
}
