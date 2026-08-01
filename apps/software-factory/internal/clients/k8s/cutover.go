package k8s

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// LegacySandbox is an SDK-free snapshot of one pre-activation sandbox pod.
// UID prevents a later cleanup from deleting a replacement object by name.
type LegacySandbox struct {
	Name   string
	UID    string
	RunID  string
	Ticket string
}

// ListLegacySandboxes returns only pods carrying the legacy sandbox identity.
// The selector deliberately excludes target Run Worker pods.
func (s *Sandboxes) ListLegacySandboxes(ctx context.Context) ([]LegacySandbox, error) {
	pods, err := s.cs.CoreV1().Pods(s.ns).List(ctx, metav1.ListOptions{LabelSelector: sandboxSelector()})
	if err != nil {
		return nil, fmt.Errorf("listing legacy sandbox pods in %s: %w", s.ns, err)
	}
	result := make([]LegacySandbox, 0, len(pods.Items))
	for _, pod := range pods.Items {
		result = append(result, LegacySandbox{
			Name:   pod.Name,
			UID:    string(pod.UID),
			RunID:  pod.Labels[labelRunID],
			Ticket: pod.Labels[labelTicket],
		})
	}
	return result, nil
}

// DeleteLegacySandbox deletes exactly the legacy pod observed by inventory
// and waits until that object is absent. A same-name replacement is preserved.
func (s *Sandboxes) DeleteLegacySandbox(ctx context.Context, sandbox LegacySandbox) error {
	if sandbox.Name == "" || sandbox.UID == "" {
		return fmt.Errorf("deleting inventoried legacy sandbox: name and UID are required")
	}
	current, err := s.cs.CoreV1().Pods(s.ns).Get(ctx, sandbox.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading inventoried legacy sandbox %s/%s: %w", sandbox.Name, sandbox.UID, err)
	}
	if string(current.UID) != sandbox.UID {
		return nil
	}
	if current.Labels[labelName] != labelNameValue || current.Labels[labelManagedBy] != labelManagedByValue {
		return nil
	}
	uid := types.UID(sandbox.UID)
	if err := s.cs.CoreV1().Pods(s.ns).Delete(ctx, sandbox.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("deleting inventoried legacy sandbox %s/%s: %w", sandbox.Name, sandbox.UID, err)
	}
	for {
		current, err := s.cs.CoreV1().Pods(s.ns).Get(ctx, sandbox.Name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) || (err == nil && string(current.UID) != sandbox.UID) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("proving legacy sandbox %s/%s absent: %w", sandbox.Name, sandbox.UID, err)
		}
		if err := s.clk.Sleep(ctx, deletePoll); err != nil {
			return fmt.Errorf("waiting for legacy sandbox %s/%s to disappear: %w", sandbox.Name, sandbox.UID, err)
		}
	}
}
