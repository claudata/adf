const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const base = JSON.parse(fs.readFileSync(path.join(root, "adf-pipelines.json"), "utf8"));
const clone = value => JSON.parse(JSON.stringify(value));
const expression = value => ({ value, type: "Expression" });
const after = name => [{ activity: name, dependencyConditions: ["Succeeded"] }];
const policy = {
  timeout: "0.00:30:00",
  retry: "[parameters('copyRetries')]",
  retryIntervalInSeconds: "[parameters('retryIntervalSeconds')]",
  secureInput: true,
  secureOutput: false,
};
const runtime = { referenceName: "PrivateAzureIR", type: "IntegrationRuntimeReference" };
const checkpointKey = "@replace(replace(replace(base64(string(createArray(pipeline().parameters.companyId, " +
  "pipeline().parameters.apiPath, pipeline().parameters.entity))), '/', '_'), '+', '-'), '=', '')";
function resource(type, name, properties, dependencies = []) {
  return {
    type: `Microsoft.DataFactory/factories/${type}`,
    apiVersion: "2018-06-01",
    name: `[concat(parameters('factoryName'), '/${name}')]`,
    dependsOn: dependencies.map(([kind, id]) =>
      `[resourceId('Microsoft.DataFactory/factories/${kind}', parameters('factoryName'), '${id}')]`),
    properties,
  };
}
function set(name, variableName, value, dependency) {
  return {
    name, type: "SetVariable", dependsOn: dependency ? after(dependency) : [],
    typeProperties: { variableName, value: expression(value) },
  };
}
function failIf(name, condition, code, message, dependency) {
  return {
    name, type: "IfCondition", dependsOn: dependency ? after(dependency) : [],
    typeProperties: {
      expression: expression(condition),
      ifTrueActivities: [{ name: `Fail${name}`, type: "Fail", typeProperties: { errorCode: code, message } }],
      ifFalseActivities: [],
    },
  };
}

for (const variant of ["rest", "odata"]) {
  const odata = variant === "odata";
  const prefix = odata ? "pl-odata-" : "pl-";
  const sourceDataset = odata ? "ds_bc_odata" : "ds_bc_rest";
  const rawDataset = odata ? "ds_odata_raw_json" : "ds_raw_json";
  const sourceLink = odata ? "ls_business_central_odata" : "ls_business_central";
  const entityPipeline = `${prefix}extract-entity`;
  const fullPipeline = `${prefix}extract-entity-full`;
  const batchPipeline = `${prefix}extract-batch`;
  const tableDataset = "ds_bc_checkpoints";
  const template = {
    $schema: base.$schema, contentVersion: "2.0.0.0",
    parameters: {
      ...clone(base.parameters),
      copyRetries: { type: "int", defaultValue: 3, minValue: 0, maxValue: 10 },
      retryIntervalSeconds: { type: "int", defaultValue: 60, minValue: 30, maxValue: 900 },
      restRequestInterval: {
        type: "string", defaultValue: "00.00:00:01",
        allowedValues: ["00.00:00:01", "00.00:00:02", "00.00:00:05", "00.00:00:10"],
      },
    },
    resources: [],
  };
  const find = name => {
    const found = base.resources.find(item => item.name.endsWith(`/${name}')]`));
    if (!found) throw new Error(`Missing base resource ${name}`);
    return clone(found);
  };
  template.resources.push(find("ls_key_vault"), find("ls_adls_gen2"));
  const linked = find("ls_business_central");
  if (odata) {
    linked.name = "[concat(parameters('factoryName'), '/ls_business_central_odata')]";
    linked.properties.parameters = { apiPath: { type: "String", defaultValue: "api/v2.0" } };
    linked.properties.type = "OData";
    const props = linked.properties.typeProperties;
    props.url = {
      type: "Expression",
      value: "[concat('@concat(''https://api.businesscentral.dynamics.com/v2.0/', parameters('tenantId'), '/', parameters('environment'), '/'', linkedService().apiPath, ''/'')')]",
    };
    props.aadServicePrincipalCredentialType = props.servicePrincipalCredentialType;
    delete props.servicePrincipalCredentialType;
    delete props.enableServerCertificateValidation;
  }
  template.resources.push(linked);
  const raw = find("ds_raw_json");
  raw.name = `[concat(parameters('factoryName'), '/${rawDataset}')]`;
  template.resources.push(raw);
  if (odata) {
    template.resources.push(resource("datasets", sourceDataset, {
      type: "ODataResource", schema: [],
      parameters: { relativeUrl: { type: "String" }, apiPath: { type: "String", defaultValue: "api/v2.0" } },
      linkedServiceName: {
        referenceName: sourceLink, type: "LinkedServiceReference",
        parameters: { apiPath: expression("@dataset().apiPath") },
      },
      typeProperties: { path: expression("@dataset().relativeUrl") },
    }, [["linkedservices", sourceLink]]));
  } else {
    template.resources.push(find(sourceDataset));
  }
  template.resources.push(
    resource("linkedservices", "ls_bc_checkpoints", {
      type: "AzureTableStorage", connectVia: runtime,
      typeProperties: { serviceEndpoint: "[concat('https://', parameters('storageName'), '.table.core.windows.net/')]" },
    }),
    resource("datasets", tableDataset, {
      type: "AzureTable", schema: [],
      linkedServiceName: { referenceName: "ls_bc_checkpoints", type: "LinkedServiceReference" },
      typeProperties: { tableName: "BcExtractionCheckpoint" },
    }, [["linkedservices", "ls_bc_checkpoints"]]),
  );
  const partition = `[concat(parameters('tenantId'), '|', parameters('environment'), '|${variant}')]`;
  function checkpointLookup(name, dependency) {
    return {
      name, type: "Lookup", dependsOn: dependency ? after(dependency) : [], policy: clone(policy),
      typeProperties: {
        source: {
          type: "AzureTableSource",
          azureTableSourceQuery: expression("@concat('PartitionKey eq ''', variables('partitionKey'), " +
            "''' and RowKey eq ''', variables('checkpointKey'), '''')"),
          azureTableSourceIgnoreTableNotFound: false,
        },
        dataset: { referenceName: tableDataset, type: "DatasetReference" }, firstRowOnly: false,
      },
    };
  }
  function input(relativeUrl) {
    return {
      referenceName: sourceDataset, type: "DatasetReference",
      parameters: {
        relativeUrl: expression(relativeUrl),
        ...(odata ? { apiPath: expression("@pipeline().parameters.apiPath") } : {}),
      },
    };
  }
  function source(query = "") {
    return odata ? {
      type: "ODataSource", httpRequestTimeout: "00:02:00", ...(query ? { query: expression(query) } : {}),
    } : {
      type: "RestSource", requestMethod: "GET", httpRequestTimeout: "00:02:00",
      requestInterval: "[parameters('restRequestInterval')]",
      additionalHeaders: { Prefer: expression("@concat('odata.maxpagesize=', string(pipeline().parameters.pageSize))") },
      paginationRules: { AbsoluteUrl: "$['@odata.nextLink']", supportRFC5988: "false" },
    };
  }
  const parameters = {
    companyId: { type: "String" }, entity: { type: "String", defaultValue: "customers" },
    apiPath: { type: "String", defaultValue: "api/v2.0" },
    loadMode: { type: "String", defaultValue: "Full" },
    initialWatermark: { type: "String", defaultValue: "1970-01-01T00:00:00Z" },
    windowEnd: { type: "String", defaultValue: "" },
    safetyLagSeconds: { type: "Int", defaultValue: 120 },
    overlapSeconds: { type: "Int", defaultValue: 120 },
    cooldownSeconds: { type: "Int", defaultValue: 2 },
    ...(!odata ? { pageSize: { type: "Int", defaultValue: 1000 } } : {}),
  };
  const fullParameters = Object.fromEntries(Object.entries(parameters).filter(([key]) =>
    ["companyId", "entity", "apiPath", "pageSize"].includes(key)));
  const query = "@if(equals(pipeline().parameters.loadMode, 'Incremental'), " +
    "concat('$filter=lastModifiedDateTime ge ', variables('lowerBound'), " +
    "' and lastModifiedDateTime lt ', variables('upperBound'), '&$orderby=lastModifiedDateTime asc'), '')";
  const pathExpression = "@concat(" + (odata ? "" : "pipeline().parameters.apiPath, '/', ") +
    "'companies(', pipeline().parameters.companyId, ')/', pipeline().parameters.entity)";
  const copy = {
    name: "CopyEntity", type: "Copy", dependsOn: after("Cooldown"),
    policy: { ...clone(policy), timeout: "0.01:00:00" },
    typeProperties: {
      source: source(query),
      sink: {
        type: "JsonSink", storeSettings: { type: "AzureBlobFSWriteSettings" },
        formatSettings: { type: "JsonWriteSettings", filePattern: "arrayOfObjects" },
      },
      enableStaging: false,
    },
    inputs: [input(odata ? pathExpression :
      `@concat(${pathExpression.slice(1)}, if(equals(pipeline().parameters.loadMode, 'Incremental'), concat('?', variables('query')), ''))`)],
    outputs: [{
      referenceName: rawDataset, type: "DatasetReference",
      parameters: { folderPath: expression("@variables('outputFolder')"), fileName: "response-pages.json" },
    }],
  };
  const checkpointFields = {
    PartitionKey: "@variables('partitionKey')", RowKey: "@variables('checkpointKey')",
    Watermark: "@variables('upperBound')", RunId: "@pipeline().RunId",
    OutputFolder: "@variables('outputFolder')", LowerBound: "@variables('lowerBound')",
  };
  const commitSource = odata
    ? { type: "ODataSource", query: expression("@concat('$select=id&$filter=id eq ', pipeline().parameters.companyId)"), httpRequestTimeout: "00:02:00" }
    : { type: "RestSource", requestMethod: "GET", httpRequestTimeout: "00:02:00" };
  commitSource.additionalColumns = Object.entries(checkpointFields).map(([name, value]) => ({
    name, value: expression(value),
  }));
  const commit = {
    name: "CommitCheckpoint", type: "Copy", policy: clone(policy),
    typeProperties: {
      source: commitSource,
      sink: {
        type: "AzureTableSink", azureTablePartitionKeyName: "PartitionKey",
        azureTableRowKeyName: "RowKey", azureTableInsertType: "replace",
        writeBatchSize: 1, maxConcurrentConnections: 1,
      },
      translator: {
        type: "TabularTranslator",
        mappings: Object.keys(checkpointFields).map(name => ({
          source: odata ? { name, type: "String" } : { path: `$['${name}']`, type: "String" },
          sink: { name, type: "String" },
        })),
      },
    },
    inputs: [input(odata ? "@'companies'" :
      "@concat('api/v2.0/companies(', pipeline().parameters.companyId, ')?$select=id')")],
    outputs: [{ referenceName: tableDataset, type: "DatasetReference" }],
  };
  if (odata) commit.inputs[0].parameters.apiPath = "api/v2.0";
  const commitActivities = [
    commit,
    {
      name: "ReadCommittedCheckpoint", type: "Lookup", dependsOn: after("CommitCheckpoint"),
      policy: clone(policy), typeProperties: checkpointLookup("Unused").typeProperties,
    },
    failIf("VerifyCommit",
      "@not(and(equals(activity('CommitCheckpoint').output.rowsCopied, 1), " +
      "if(equals(activity('ReadCommittedCheckpoint').output.count, 1), " +
      "and(equals(activity('ReadCommittedCheckpoint').output.value[0].Watermark, variables('upperBound')), " +
      "equals(activity('ReadCommittedCheckpoint').output.value[0].RunId, pipeline().RunId)), false)))",
      "CheckpointCommitNotConfirmed", "Checkpoint must contain exactly one row matching this run and window.", "ReadCommittedCheckpoint"),
  ];
  const commitPipeline = `${prefix}commit-checkpoint`;
  const commitParameters = ["companyId", "apiPath", "partitionKey", "checkpointKey", "upperBound", "lowerBound", "outputFolder", "sourceRunId"];
  const commitJson = JSON.stringify(commitActivities)
    .replace(/variables\('([^']+)'\)/g, "pipeline().parameters.$1")
    .replaceAll("pipeline().RunId", "pipeline().parameters.sourceRunId");
  template.resources.push(resource("pipelines", commitPipeline, {
    description: "Internal commit helper. Invoke only through the serialized extraction entrypoint after successful copy/output checks.",
    parameters: Object.fromEntries(commitParameters.map(name => [name, { type: "String" }])),
    activities: JSON.parse(commitJson),
  }, [["datasets", sourceDataset], ["datasets", tableDataset]]));
  const invalidParameters =
      "or(not(contains(createArray('Full', 'Incremental'), pipeline().parameters.loadMode)), " +
      "or(or(less(pipeline().parameters.safetyLagSeconds, 0), less(pipeline().parameters.overlapSeconds, 0)), " +
      "or(or(greater(pipeline().parameters.safetyLagSeconds, 86400), greater(pipeline().parameters.overlapSeconds, 86400)), " +
      "or(less(pipeline().parameters.cooldownSeconds, 0), greater(pipeline().parameters.cooldownSeconds, 300)))))";
  const activities = [
    failIf("ValidateParameters", odata ? `@${invalidParameters}` :
      `@or(${invalidParameters}, or(less(pipeline().parameters.pageSize, 1), greater(pipeline().parameters.pageSize, 20000)))`,
      "InvalidParameters", "Use Full or Incremental with lag/overlap 0..86400, cooldown 0..300 seconds, and REST pageSize 1..20000."),
    set("SetCheckpointKey", "checkpointKey", checkpointKey, "ValidateParameters"),
    failIf("ValidateCheckpointKey", "@greater(length(variables('checkpointKey')), 1024)",
      "CheckpointKeyTooLong", "Encoded company/API/entity identity exceeds the Table row-key limit.", "SetCheckpointKey"),
    set("CaptureUpperBound", "upperBound",
      "@formatDateTime(if(empty(pipeline().parameters.windowEnd), " +
      "addSeconds(utcNow(), mul(-1, pipeline().parameters.safetyLagSeconds)), pipeline().parameters.windowEnd), 'yyyy-MM-ddTHH:mm:ss.fffffffZ')",
      "ValidateCheckpointKey"),
    checkpointLookup("ReadCheckpoint", "CaptureUpperBound"),
    set("SetCommittedWatermark", "committedWatermark",
      "@if(equals(activity('ReadCheckpoint').output.count, 0), pipeline().parameters.initialWatermark, " +
      "activity('ReadCheckpoint').output.value[0].Watermark)", "ReadCheckpoint"),
    failIf("ValidateWindow",
      "@and(equals(pipeline().parameters.loadMode, 'Incremental'), or(" +
      "greater(ticks(variables('upperBound')), ticks(addSeconds(utcNow(), mul(-1, pipeline().parameters.safetyLagSeconds)))), " +
      "lessOrEquals(ticks(variables('upperBound')), ticks(variables('committedWatermark')))))",
      "InvalidIncrementalWindow", "Window end must advance the checkpoint and cannot exceed now minus safety lag.", "SetCommittedWatermark"),
    set("SetLowerBound", "lowerBound",
      "@formatDateTime(addSeconds(variables('committedWatermark'), mul(-1, pipeline().parameters.overlapSeconds)), 'yyyy-MM-ddTHH:mm:ss.fffffffZ')",
      "ValidateWindow"),
    set("SetQuery", "query", query, "SetLowerBound"),
    set("SetOutputFolder", "outputFolder",
      "@concat('business-central/" + (odata ? "odata/" : "") +
      "', pipeline().parameters.companyId, '/', pipeline().parameters.entity, '/', " +
      "formatDateTime(pipeline().TriggerTime, 'yyyy/MM/dd'), '/', pipeline().RunId)", "SetQuery"),
    {
      name: "Cooldown", type: "Wait", dependsOn: after("SetOutputFolder"),
      typeProperties: { waitTimeInSeconds: expression("@pipeline().parameters.cooldownSeconds") },
    },
    copy,
    {
      name: "InspectRawOutput", type: "GetMetadata", dependsOn: after("CopyEntity"), policy: clone(policy),
      typeProperties: {
        dataset: {
          referenceName: rawDataset, type: "DatasetReference",
          parameters: { folderPath: expression("@variables('outputFolder')"), fileName: "response-pages.json" },
        },
        fieldList: ["exists", "size"], storeSettings: { type: "AzureBlobFSReadSettings", recursive: false },
      },
    },
    failIf("ValidateRawOutput",
      "@not(or(equals(activity('CopyEntity').output.rowsCopied, 0), " +
      "if(activity('InspectRawOutput').output.exists, greater(activity('InspectRawOutput').output.size, 0), false)))",
      "InvalidRawOutput", "Successful nonempty copies must produce a nonempty raw file.", "InspectRawOutput"),
    {
      name: "CommitIncrementalOnly", type: "IfCondition", dependsOn: after("ValidateRawOutput"),
      typeProperties: {
        expression: expression("@equals(pipeline().parameters.loadMode, 'Incremental')"),
        ifTrueActivities: [{
          name: "PersistCheckpoint", type: "ExecutePipeline",
          typeProperties: {
            pipeline: { referenceName: commitPipeline, type: "PipelineReference" }, waitOnCompletion: true,
            parameters: Object.fromEntries(commitParameters.map(name => [name, expression(
              name === "sourceRunId" ? "@pipeline().RunId" :
                ["companyId", "apiPath"].includes(name) ? `@pipeline().parameters.${name}` : `@variables('${name}')`)])),
          },
        }],
        ifFalseActivities: [],
      },
    },
  ];
  template.resources.push(resource("pipelines", entityPipeline, {
    concurrency: 1,
    description: "Serialized full/incremental extraction. Incremental commits an atomic Table entity only after copy and output checks. Timestamp windows overlap; deletes and cross-factory distributed locks are not implemented.",
    parameters,
    variables: Object.fromEntries(["checkpointKey", "upperBound", "committedWatermark", "lowerBound", "query", "outputFolder"]
      .map(name => [name, { type: "String" }]).concat([["partitionKey", { type: "String", defaultValue: partition }]])),
    activities,
  }, [["datasets", sourceDataset], ["datasets", rawDataset], ["datasets", tableDataset], ["pipelines", commitPipeline]]));
  template.resources.push(resource("pipelines", fullPipeline, {
    description: "Compatibility full-load wrapper. Full runs do not change incremental checkpoints.",
    parameters: fullParameters,
    activities: [{
      name: "ExtractFull", type: "ExecutePipeline",
      typeProperties: {
        pipeline: { referenceName: entityPipeline, type: "PipelineReference" }, waitOnCompletion: true,
        parameters: {
          ...Object.fromEntries(Object.keys(fullParameters).map(name => [name, expression(`@pipeline().parameters.${name}`)])),
          loadMode: "Full",
        },
      },
    }],
  }, [["pipelines", entityPipeline]]));
  function batch(name, incremental) {
    const fields = ["companyId", "entity", "apiPath", ...(!odata ? ["pageSize"] : []),
      ...(incremental ? ["loadMode"] : [])];
    return resource("pipelines", name, {
      concurrency: 1, parameters: { entities: { type: "Array" } },
      description: "Sequential metadata-driven extraction; all calls enter the serialized entity pipeline.",
      activities: [{
        name: "ForEachEntity", type: "ForEach",
        typeProperties: {
          items: expression("@pipeline().parameters.entities"), isSequential: true,
          activities: [{
            name: "ExtractEntity", type: "ExecutePipeline",
            typeProperties: {
              pipeline: { referenceName: entityPipeline, type: "PipelineReference" }, waitOnCompletion: true,
              parameters: {
                ...Object.fromEntries(fields.map(field => [field, expression(`@item().${field}`)])),
                ...(!incremental ? { loadMode: "Full" } : {}),
              },
            },
          }],
        },
      }],
    }, [["pipelines", entityPipeline]]);
  }
  template.resources.push(batch(batchPipeline, true), batch(`${prefix}extract-batch-full`, false));
  const discovery = find("pl-discover-companies");
  if (odata) {
    discovery.name = "[concat(parameters('factoryName'), '/pl-odata-discover-companies')]";
    discovery.dependsOn = [["datasets", sourceDataset], ["datasets", rawDataset]].map(([kind, name]) =>
      `[resourceId('Microsoft.DataFactory/factories/${kind}', parameters('factoryName'), '${name}')]`);
    discovery.properties.description = "Discovers authorized companies as flat OData records; rejects an empty result.";
    discovery.properties.activities = discovery.properties.activities.filter(a => a.name !== "NonemptyCompanyPages");
    const discoverCopy = discovery.properties.activities.find(a => a.name === "CopyCompanies");
    discoverCopy.typeProperties.source = { type: "ODataSource", query: "$select=id,name,displayName", httpRequestTimeout: "00:02:00" };
    discoverCopy.inputs = [{
      referenceName: sourceDataset, type: "DatasetReference",
      parameters: { relativeUrl: "companies", apiPath: "api/v2.0" },
    }];
    discoverCopy.outputs[0].referenceName = rawDataset;
    discoverCopy.outputs[0].parameters.folderPath = expression("@concat('business-central/odata/company-discovery/', pipeline().RunId)");
    const read = discovery.properties.activities.find(a => a.name === "ReadCompanies");
    read.typeProperties.dataset.referenceName = rawDataset;
    read.typeProperties.dataset.parameters.folderPath = clone(discoverCopy.outputs[0].parameters.folderPath);
    const guard = discovery.properties.activities.find(a => a.name === "RequireAuthorizedCompany");
    guard.dependsOn = after("ReadCompanies");
    guard.typeProperties.expression = expression("@equals(activity('ReadCompanies').output.count, 0)");
  }
  for (const activity of discovery.properties.activities) {
    if (activity.policy) activity.policy = clone(policy);
  }
  template.resources.push(discovery);
  const validation = find("pl-validate-raw-json");
  if (odata) {
    validation.name = "[concat(parameters('factoryName'), '/pl-odata-validate-raw-json')]";
    validation.dependsOn = [`[resourceId('Microsoft.DataFactory/factories/datasets', parameters('factoryName'), '${rawDataset}')]`];
    for (const activity of validation.properties.activities) {
      activity.typeProperties.dataset.referenceName = rawDataset;
    }
  }
  template.resources.push(validation);
  template.resources.push(resource("pipelines", `${prefix}read-checkpoint`, {
    description: "Read-only checkpoint inspection; uses the same derived key and connector-isolated partition.",
    parameters: fullParameters,
    variables: { checkpointKey: { type: "String" }, partitionKey: { type: "String", defaultValue: partition } },
    activities: [
      set("SetCheckpointKey", "checkpointKey", checkpointKey),
      checkpointLookup("ReadCheckpoint", "SetCheckpointKey"),
    ],
  }, [["datasets", tableDataset]]));
  const directory = odata ? path.join(root, "odata") : root;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "adf-pipelines.json"), JSON.stringify(template, null, 2) + "\n");
  console.log(`${variant}: ${template.resources.length} resources`);
}
