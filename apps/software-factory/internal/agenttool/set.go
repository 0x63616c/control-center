package agenttool

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
)

// ToolsetID identifies one immutable meaning of a tool catalogue.
type ToolsetID string

type runtimeTool interface {
	Specification() Specification
	Execute(context.Context, json.RawMessage) (Result, error)
}

// Set is an immutable versioned catalogue of tools.
type Set struct {
	id             ToolsetID
	tools          map[string]runtimeTool
	specifications []Specification
	fingerprint    string
}

// MustSet constructs a versioned tool catalogue or panics when its contract is invalid.
func MustSet(id ToolsetID, tools ...runtimeTool) Set {
	set := Set{
		id:             id,
		tools:          make(map[string]runtimeTool, len(tools)),
		specifications: make([]Specification, 0, len(tools)),
	}
	for _, tool := range tools {
		specification := tool.Specification()
		if _, exists := set.tools[specification.Name]; exists {
			panic(fmt.Sprintf("agenttool: duplicate tool %q in toolset %q", specification.Name, id))
		}
		set.tools[specification.Name] = tool
		set.specifications = append(set.specifications, specification)
	}
	sort.Slice(set.specifications, func(i, j int) bool {
		return set.specifications[i].Name < set.specifications[j].Name
	})
	canonical, err := json.Marshal(struct {
		ID             ToolsetID       `json:"id"`
		Specifications []Specification `json:"specifications"`
	}{ID: id, Specifications: set.specifications})
	if err != nil {
		panic(fmt.Sprintf("agenttool: fingerprint toolset %q: %v", id, err))
	}
	set.fingerprint = fmt.Sprintf("sha256:%x", sha256.Sum256(canonical))
	return set
}

// Specifications returns model-facing definitions in deterministic name order.
func (s Set) Specifications() []Specification {
	specifications := make([]Specification, len(s.specifications))
	for index, specification := range s.specifications {
		specifications[index] = Specification{
			Name:        specification.Name,
			Description: specification.Description,
			Parameters:  append(json.RawMessage(nil), specification.Parameters...),
		}
	}
	return specifications
}

// Fingerprint returns the stable digest of the toolset identity and schemas.
func (s Set) Fingerprint() string {
	return s.fingerprint
}
