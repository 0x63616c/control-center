package workflows

import (
	"context"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/database/databasetest"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/google/uuid"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// newRealStoreForFactoryLoopTest returns a Store over a real, migrated
// PostgreSQL database, or skips the test if none is configured — see
// databasetest.NewPool's own doc comment for why this package uses that
// helper rather than opening database/sql itself: .golangci.yml's
// workflows-are-deterministic rule denies that import from every file under
// internal/workflows, test files included.
//
// A real Store is required here, not storefake: storefake.PutTranscript
// (internal/store/storefake/transcripts.go) never checks the transcript
// table's foreign key, so it could never have caught software-factory#602 no
// matter what order a caller writes in — only a real Postgres enforces it.
func newRealStoreForFactoryLoopTest(t *testing.T) *store.Store {
	t.Helper()
	return store.New(databasetest.NewPool(t))
}

// factoryPlanTurnOrderingInput names the one Ticket and Run
// factoryPlanTurnOrderingWorkflow's runFactoryPlanTurn call records against.
type factoryPlanTurnOrderingInput struct {
	TicketID store.TicketID
	RunID    string
}

// factoryPlanTurnOrderingWorkflow runs exactly the one recording sequence
// runFactoryPlanTurn makes on its success path, against whatever activities
// the test environment registers.
//
// It exists so software-factory#602's regression test can drive that real
// sequence without standing up the whole FactoryWorkTicket workflow: this
// package's own runID always comes from workflow.GetInfo(ctx).WorkflowExecution.RunID
// (see FactoryWorkTicket), and TestWorkflowEnvironment cannot be told to
// mint that as a UUID — the `run` table's primary key type, which a plain
// "default-test-run-id" fails outright. Building a factoryTicketRun
// directly and choosing a real UUID for its runID sidesteps that
// test-harness limit entirely.
func factoryPlanTurnOrderingWorkflow(ctx workflow.Context, in factoryPlanTurnOrderingInput) error {
	r := &factoryTicketRun{
		in: FactoryWorkTicketInput{
			TicketID: in.TicketID,
			Config:   work.DefaultFactoryConfig(),
			Policy:   work.DefaultRunPolicy(),
		},
		runID: in.RunID,
	}
	stages := workflow.WithActivityOptions(ctx, r.stageOptions())
	prior := make(map[work.Stage][]work.StageOutput, 1)
	_, err := r.runFactoryPlanTurn(ctx, stages, work.TicketDetail{}, prior)
	return err
}

// TestRunFactoryPlanTurnRecordsTheAttemptBeforePersistingItsTranscriptAgainstARealDatabase
// is software-factory#602's regression test.
//
// Before the fix, runFactoryPlanTurn's success path called persistTranscript
// before recordAttempt, so PersistTranscriptToStore always raced the Attempt
// row its own foreign key requires (transcript_run_id_stage_turn_attempt_no_fkey)
// — the insert violated it (SQLSTATE 23503) on every turn, exactly the
// production failure the issue quotes verbatim. persistTranscript's error
// handling is deliberately best-effort (it logs and moves on, matching
// ticketRun.persistTranscript on the unmodified GitHub-driven pipeline), so
// the violation never failed the run or this workflow — it silently dropped
// the transcript instead. Run against that ordering, this test's closing
// s.Transcript lookup fails with "not found"; the attempt row above it is
// still there, matching the issue's own observation that attempts ARE
// recorded while the transcript never lands. Fixed (recordAttempt first),
// the transcript is retrievable afterward like any other one.
func TestRunFactoryPlanTurnRecordsTheAttemptBeforePersistingItsTranscriptAgainstARealDatabase(t *testing.T) {
	s := newRealStoreForFactoryLoopTest(t)
	ctx := context.Background()

	ticket, err := s.CreateTicket(ctx, "ordering", "b", nil)
	if err != nil {
		t.Fatalf("CreateTicket: %v", err)
	}
	runID := uuid.NewString()
	startedAt := time.Date(2026, 7, 31, 9, 0, 0, 0, time.UTC)
	if _, err := s.StartRun(ctx, runID, ticket.ID, startedAt); err != nil {
		t.Fatalf("StartRun: %v", err)
	}

	recordingActivities, err := activities.NewRecordingActivities(s)
	if err != nil {
		t.Fatalf("building recording activities: %v", err)
	}
	transcriptActivities, err := activities.NewTranscriptRecordingActivities(s)
	if err != nil {
		t.Fatalf("building transcript activities: %v", err)
	}

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivity(recordingActivities)
	env.RegisterActivity(transcriptActivities)

	transcript := work.Transcript(`{"type":"turn.completed","stage":"plan"}`)
	env.OnActivity(acts.RunPlan, mock.Anything, mock.Anything).
		Return(func(_ context.Context, _ activities.RunPlanInput) (*activities.RunPlanOutput, error) {
			var out activities.RunPlanOutput
			out.Output = []byte(`{"result":"plan"}`)
			out.Result = work.NewStageOutput(work.StagePlan, work.DocumentOutput{Document: "the plan"})
			out.ThreadID = "thread-plan"
			out.Usage = work.Usage{InputTokens: 10, OutputTokens: 1}
			out.Transcript = transcript
			return &out, nil
		})

	env.ExecuteWorkflow(factoryPlanTurnOrderingWorkflow, factoryPlanTurnOrderingInput{
		TicketID: ticket.ID,
		RunID:    runID,
	})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow: %v", err)
	}

	key := work.StageKey{Ticket: int(ticket.ID), RunID: runID, Stage: work.StagePlan, Turn: 1}

	attempts, err := s.AttemptsForStep(ctx, key)
	if err != nil {
		t.Fatalf("AttemptsForStep: %v", err)
	}
	if len(attempts) != 1 {
		t.Fatalf("AttemptsForStep() = %+v, want exactly one recorded attempt", attempts)
	}

	got, err := s.Transcript(ctx, key, 1)
	if err != nil {
		t.Fatalf("Transcript: %v — software-factory#602's transcript-before-attempt ordering "+
			"violates the foreign key and silently drops the transcript instead of storing it", err)
	}
	if string(got.CompressedBytes) == "" {
		t.Fatal("Transcript().CompressedBytes is empty, want the compressed transcript bytes")
	}
}
