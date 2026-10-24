namespace UnderwritingOrchestrator.Underwriting;

/// <summary>
/// A limited number of concurrent LLM calls, like a real quota (Llm:MaxConcurrency). When no slot is free, the
/// waiting steps are served by priority, not by arrival order.
/// </summary>
public sealed class LlmSlots(int capacity)
{
    private readonly Lock _gate = new();
    private readonly PriorityQueue<TaskCompletionSource, int> _waiting = new();
    private int _free = capacity;

    /// <summary>Takes a slot; <paramref name="onQueued"/> runs only when the step has to wait for one.</summary>
    public async Task<IDisposable> EnterAsync(int priority, Action onQueued, CancellationToken ct)
    {
        TaskCompletionSource ticket;
        lock (_gate)
        {
            if (_free > 0)
            {
                _free--;
                return new Slot(this);
            }
            ticket = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiting.Enqueue(ticket, priority);
        }
        onQueued();
        await ticket.Task.WaitAsync(ct);
        return new Slot(this);
    }

    private void Leave()
    {
        lock (_gate)
        {
            if (_waiting.TryDequeue(out var next, out _)) next.SetResult(); // the slot goes straight to the next one
            else _free++;
        }
    }

    private sealed class Slot(LlmSlots slots) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0) slots.Leave();
        }
    }
}
