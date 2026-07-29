package work

// TaskQueue is the Temporal task queue this service's workflows and activities
// are scheduled on, and the only place its name is written.
//
// It belongs here because two sides need it and neither can own it. The
// composition root registers a worker that polls this queue; workflow code
// names it again in the child-workflow and activity options it builds, because
// Temporal has no notion of "the queue I am already on" for work it schedules
// elsewhere. Written twice, the two spellings would agree until one of them was
// changed, and then the system would be a worker polling a queue nobody sends
// to — which looks exactly like nothing happening, and reports no error at
// either end.
//
// It is a constant rather than configuration for the same reason. A queue name
// that could be set per environment would let the worker and the workflows that
// schedule onto it disagree at runtime, which is the failure above with an
// environment variable in front of it. Pointing a worker at an experimental
// queue is a change to this line and a deploy — deliberate, reviewable, and
// impossible to do to one side only.
//
// The same fact by the same rule as WorkflowID in paths.go: one name, one home,
// nothing else may construct it.
const TaskQueue = "software-factory"
