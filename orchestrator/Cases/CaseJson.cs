using System.Text.Json;
using System.Text.Json.Serialization;

namespace UnderwritingOrchestrator.Cases;

/// <summary>JSON shape of the API: camelCase fields, UPPER_CASE enums (IN_PROGRESS, ACCEPT_WITH_SURCHARGE…), no nulls.</summary>
public static class CaseJson
{
    public static void Configure(JsonSerializerOptions options)
    {
        options.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        options.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseUpper));
    }

    public static readonly JsonSerializerOptions Options = Create();

    private static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        Configure(options);
        return options;
    }
}
