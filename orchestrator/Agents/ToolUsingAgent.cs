using System.Text.Json.Nodes;
using UnderwritingOrchestrator.Dependencies;
using UnderwritingOrchestrator.Underwriting;
using Microsoft.Extensions.Options;

namespace UnderwritingOrchestrator.Agents;

/// <summary>A tool the agent ran through MCP, with what it got back.</summary>
public sealed record ToolRun(string Name, JsonObject Arguments, JsonNode Output);

/// <summary>The agent's structured answer, and the tools it ran to get there.</summary>
public sealed record AgentRun(JsonObject Output, IReadOnlyList<ToolRun> ToolRuns);

/// <summary>
/// An LLM agent that uses the tools of an MCP server. The model decides which tool to call; the orchestrator only
/// relays: tools/list → LLM with tools → tool_calls run with tools/call → LLM with the results → answer.
/// </summary>
public sealed class ToolUsingAgent(LlmGatewayClient llm, McpClient mcp, IOptions<LlmOptions> options)
{
    public async Task<AgentRun> RunAsync(
        AgentPrompt prompt, string mcpEndpoint, string siren, StepCalls calls, CancellationToken ct)
    {
        // 1. Discover what the MCP server offers, and describe it to the model as OpenAI tools
        var mcpSession = await mcp.ConnectAsync(mcpEndpoint, calls, ct);
        var tools = AsOpenAiTools(await mcpSession.ListToolsAsync(ct));

        var messages = prompt.Messages();
        var toolRuns = new List<ToolRun>();
        for (var round = 0; ; round++)
        {
            // 2. Ask the model, which may answer, or ask for tools
            var reply = await llm.ChatAsync(prompt.Agent, siren, messages, tools, calls, ct);
            if (reply.ToolCalls.Count == 0)
                return new AgentRun(LlmGatewayClient.ParseAgentOutput(reply.Content ?? ""), toolRuns);
            if (round == options.Value.MaxToolRounds)
                throw new DependencyException($"l'agent demande encore un outil après {round} tours");

            // 3. Run each requested tool through MCP and hand its result back to the model
            messages.Add(reply.Message);
            foreach (var toolCall in reply.ToolCalls)
            {
                var output = await mcpSession.CallToolAsync(toolCall.Name, toolCall.Arguments, ct);
                toolRuns.Add(new ToolRun(toolCall.Name, toolCall.Arguments, output));
                messages.Add(new JsonObject
                {
                    ["role"] = "tool", ["tool_call_id"] = toolCall.Id, ["content"] = output.ToJsonString(),
                });
            }
        }
    }

    /// <summary>MCP tool → OpenAI function tool: the MCP inputSchema is already a JSON Schema.</summary>
    private static JsonArray AsOpenAiTools(IEnumerable<McpTool> tools) =>
        new(tools.Select(tool => (JsonNode)new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = tool.Name,
                ["description"] = tool.Description,
                ["parameters"] = tool.InputSchema.DeepClone(),
            },
        }).ToArray());
}
