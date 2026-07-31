package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/payloads"
	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/sdk/converter"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestDecodeRoundTripsAnOffloadedPayload(t *testing.T) {
	t.Parallel()

	store := blobs.NewMemStore()
	value := strings.Repeat("compressible payload ", 4096)
	original, err := converter.GetDefaultDataConverter().ToPayload(value)
	if err != nil {
		t.Fatalf("default ToPayload() error = %v", err)
	}
	encoded, err := payloads.DataConverter(store, nil).ToPayload(value)
	if err != nil {
		t.Fatalf("codec ToPayload() error = %v", err)
	}
	response := servePayloads(t, newHandler(store, []string{"https://temporal.example"}), "/{namespace}/decode", &commonpb.Payloads{Payloads: []*commonpb.Payload{encoded}})

	if response.Code != http.StatusOK {
		t.Fatalf("POST /decode status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	decoded := decodePayloads(t, response)
	if !proto.Equal(decoded.Payloads[0], original) {
		t.Errorf("decoded payload = %v, want %v", decoded.Payloads[0], original)
	}
}

func TestEncodeRoute(t *testing.T) {
	t.Parallel()

	store := blobs.NewMemStore()
	original, err := converter.GetDefaultDataConverter().ToPayload("codec route round trip")
	if err != nil {
		t.Fatalf("default ToPayload() error = %v", err)
	}
	handler := newHandler(store, []string{"https://temporal.example"})
	encoded := servePayloads(t, handler, "/{namespace}/encode", &commonpb.Payloads{Payloads: []*commonpb.Payload{original}})
	if encoded.Code != http.StatusOK {
		t.Fatalf("POST /encode status = %d, want %d: %s", encoded.Code, http.StatusOK, encoded.Body.String())
	}
	decoded := servePayloads(t, handler, "/{namespace}/decode", decodePayloads(t, encoded))
	if decoded.Code != http.StatusOK {
		t.Fatalf("POST /decode status = %d, want %d: %s", decoded.Code, http.StatusOK, decoded.Body.String())
	}
	if got := decodePayloads(t, decoded); !proto.Equal(got, &commonpb.Payloads{Payloads: []*commonpb.Payload{original}}) {
		t.Errorf("POST /encode then /decode = %v, want %v", got, original)
	}
}

func TestCORSPreflightAllowsTheConfiguredOrigin(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodOptions, "/decode", nil)
	request.Header.Set("Origin", "https://temporal.example")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	response := httptest.NewRecorder()

	newHandler(blobs.NewMemStore(), []string{"https://temporal.example"}).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Errorf("OPTIONS /decode status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "https://temporal.example" {
		t.Errorf("Access-Control-Allow-Origin = %q, want configured origin", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Methods"); got != http.MethodPost {
		t.Errorf("Access-Control-Allow-Methods = %q, want %q", got, http.MethodPost)
	}
	if got := response.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type, X-Namespace" {
		t.Errorf("Access-Control-Allow-Headers = %q, want namespace header", got)
	}
	if got := response.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want true", got)
	}
}

func TestLiteralNamespaceCodecRouteOnlyServesSoftwareFactory(t *testing.T) {
	t.Parallel()

	handler := newHandler(blobs.NewMemStore(), []string{"https://temporal.example"})
	body, err := protojson.Marshal(&commonpb.Payloads{})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	allowed := httptest.NewRequest(http.MethodPost, "/{namespace}/decode", bytes.NewReader(body))
	allowed.Header.Set("X-Namespace", "software-factory")
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusOK {
		t.Errorf("software-factory POST /{namespace}/decode status = %d, want %d", allowedResponse.Code, http.StatusOK)
	}

	denied := httptest.NewRequest(http.MethodPost, "/{namespace}/decode", bytes.NewReader(body))
	denied.Header.Set("X-Namespace", "control-center")
	deniedResponse := httptest.NewRecorder()
	handler.ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden {
		t.Errorf("control-center POST /{namespace}/decode status = %d, want %d", deniedResponse.Code, http.StatusForbidden)
	}

	wrongPath := httptest.NewRequest(http.MethodPost, "/control-center/decode", bytes.NewReader(body))
	wrongPath.Header.Set("X-Namespace", softwareFactoryTemporalNamespace)
	wrongPathResponse := httptest.NewRecorder()
	handler.ServeHTTP(wrongPathResponse, wrongPath)
	if wrongPathResponse.Code != http.StatusNotFound {
		t.Errorf("POST /control-center/decode status = %d, want %d", wrongPathResponse.Code, http.StatusNotFound)
	}
}

func TestCORSRejectsAnUnknownOrigin(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodOptions, "/decode", nil)
	request.Header.Set("Origin", "https://unknown.example")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	response := httptest.NewRecorder()

	newHandler(blobs.NewMemStore(), []string{"https://temporal.example"}).ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Errorf("OPTIONS /decode status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestHealthz(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()

	newHandler(blobs.NewMemStore(), []string{"https://temporal.example"}).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Errorf("GET /healthz status = %d, want %d", response.Code, http.StatusOK)
	}
}

func servePayloads(t *testing.T, handler http.Handler, path string, payloads *commonpb.Payloads) *httptest.ResponseRecorder {
	t.Helper()

	body, err := protojson.Marshal(payloads)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("X-Namespace", softwareFactoryTemporalNamespace)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodePayloads(t *testing.T, response *httptest.ResponseRecorder) *commonpb.Payloads {
	t.Helper()

	payloads := &commonpb.Payloads{}
	if err := protojson.Unmarshal(response.Body.Bytes(), payloads); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	return payloads
}
