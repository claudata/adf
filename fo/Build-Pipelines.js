// Generates the Dynamics 365 Finance & Operations ADF ARM templates (REST and native OData variants).
// Run: node Build-Pipelines.js
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
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
const checkpointKey = "@replace(replace(replace(base64(string(createArray(pipeline().parameters.legalEntity, " +
  "pipeline().parameters.entity))), '/', '_'), '+', '-'), '=', '')";
const tsFormat = "'yyyy-MM-ddTHH:mm:ss.fffffffZ'";

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
const set = (name, variableName, value, dependency) => ({
  name, type: "SetVariable", dependsOn: dependency ? after(dependency) : [],
  typeProperties: { variableName, value: expression(value) },
});
const failIf = (name, condition, code, message, dependency) => ({
  name, type: "IfCondition", dependsOn: dependency ? after(dependency) : [],
  typeProperties: {
    expression: expression(condition),
    ifTrueActivities: [{ name: `Fail${name}`, type: "Fail", typeProperties: { errorCode: code, message } }],
    ifFalseActivities: [],
  },
});

for (const variant of ["rest", "odata"]) {
  const odata = variant === "odata";
  const prefix = odata ? "pl-fo-odata-" : "pl-fo-";
  const sourceLink = odata ? "ls_fo_odata" : "ls_fo_rest";
  const sourceDataset = odata ? "ds_fo_odata" : "ds_fo_rest";
  const rawDataset = odata ? "ds_fo_odata_raw_json" : "ds_fo_raw_json";
  const tableDataset = "ds_fo_checkpoints";
  const entityPipeline = `${prefix}extract-entity`;
  const commitPipeline = `${prefix}commit-checkpoint`;
  const partition = `[concat(parameters('tenantId'), '|', parameters('environmentName'), '|${variant}')]`;
  const rawRoot = `dynamics-fo/${variant}`;

  const template = {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      factoryName: { type: "string" },
      tenantId: { type: "string" },
      clientId: { type: "string" },
      environmentUrl: { type: "string", metadata: { description: "https://<name>.operations.dynamics.com, no trailing slash" } },
      environmentName: { type: "string", defaultValue: "fo-sandbox" },
      storageName: { type: "string" },
      vaultName: { type: "string" },
      secretName: { type: "string", defaultValue: "fo-extraction-client-secret" },
      copyRetries: { type: "int", defaultValue: 3, minValue: 0, maxValue: 10 },
      retryIntervalSeconds: { type: "int", defaultValue: 60, minValue: 30, maxValue: 900 },
      restRequestInterval: {
        type: "string", defaultValue: "00.00:00:01",
        allowedValues: ["00.00:00:01", "00.00:00:02", "00.00:00:05", "00.00:00:10"],
      },
    },
    resources: [],
  };

  template.resources.push(
    resource("linkedservices", "ls_fo_key_vault", {
      type: "AzureKeyVault", connectVia: runtime,
      typeProperties: { baseUrl: "[concat('https://', parameters('vaultName'), '.vault.azure.net/')]" },
    }),
    resource("linkedservices", "ls_fo_adls_gen2", {
      type: "AzureBlobFS", connectVia: runtime,
      typeProperties: { url: "[concat('https://', parameters('storageName'), '.dfs.core.windows.net')]" },
    }),
  );
  const secret = {
    type: "AzureKeyVaultSecret",
    store: { referenceName: "ls_fo_key_vault", type: "LinkedServiceReference" },
    secretName: "[parameters('secretName')]",
  };
  const auth = {
    authenticationType: "AadServicePrincipal",
    servicePrincipalId: "[parameters('clientId')]",
    servicePrincipalKey: secret,
    tenant: "[parameters('tenantId')]",
    aadResourceId: "[parameters('environmentUrl')]",
  };
  if (odata) {
    template.resources.push(resource("linkedservices", sourceLink, {
      type: "OData", connectVia: runtime,
      typeProperties: {
        url: "[concat(parameters('environmentUrl'), '/data/')]",
        authenticationType: "AadServicePrincipal",
        servicePrincipalId: auth.servicePrincipalId,
        aadServicePrincipalCredentialType: "ServicePrincipalKey",
        servicePrincipalKey: secret, tenant: auth.tenant, aadResourceId: auth.aadResourceId,
      },
    }, [["linkedservices", "ls_fo_key_vault"]]));
    template.resources.push(resource("datasets", sourceDataset, {
      type: "ODataResource", schema: [],
      parameters: { relativeUrl: { type: "String" } },
      linkedServiceName: { referenceName: sourceLink, type: "LinkedServiceReference" },
      typeProperties: { path: expression("@dataset().relativeUrl") },
    }, [["linkedservices", sourceLink]]));
  } else {
    template.resources.push(resource("linkedservices", sourceLink, {
      type: "RestService", connectVia: runtime,
      typeProperties: {
        url: "[concat(parameters('environmentUrl'), '/')]", enableServerCertificateValidation: true,
        ...auth, servicePrincipalCredentialType: "ServicePrincipalKey",
      },
    }, [["linkedservices", "ls_fo_key_vault"]]));
    template.resources.push(resource("datasets", sourceDataset, {
      type: "RestResource", schema: [],
      parameters: { relativeUrl: { type: "String" } },
      linkedServiceName: { referenceName: sourceLink, type: "LinkedServiceReference" },
      typeProperties: { relativeUrl: expression("@dataset().relativeUrl") },
    }, [["linkedservices", sourceLink]]));
  }
  template.resources.push(
    resource("datasets", rawDataset, {
      type: "Json", schema: {},
      linkedServiceName: { referenceName: "ls_fo_adls_gen2", type: "LinkedServiceReference" },
      parameters: { folderPath: { type: "String" }, fileName: { type: "String" } },
      typeProperties: {
        location: {
          type: "AzureBlobFSLocation", fileSystem: "raw",
          folderPath: expression("@dataset().folderPath"), fileName: expression("@dataset().fileName"),
        },
        encodingName: "UTF-8",
      },
    }, [["linkedservices", "ls_fo_adls_gen2"]]),
    resource("linkedservices", "ls_fo_checkpoints", {
      type: "AzureTableStorage", connectVia: runtime,
      typeProperties: { serviceEndpoint: "[concat('https://', parameters('storageName'), '.table.core.windows.net/')]" },
    }),
    resource("datasets", tableDataset, {
      type: "AzureTable", schema: [],
      linkedServiceName: { referenceName: "ls_fo_checkpoints", type: "LinkedServiceReference" },
      typeProperties: { tableName: "FoExtractionCheckpoint" },
    }, [["linkedservices", "ls_fo_checkpoints"]]),
  );

  const input = relativeUrl => ({
    referenceName: sourceDataset, type: "DatasetReference",
    parameters: { relativeUrl: expression(relativeUrl) },
  });
  const checkpointLookup = (name, dependency) => ({
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
  });
  const rawOutput = (folder, file = "response-pages.json") => ({
    referenceName: rawDataset, type: "DatasetReference",
    parameters: { folderPath: expression(folder), fileName: file },
  });

  const parameters = {
    entity: { type: "String", defaultValue: "CustomersV3" },
    legalEntity: { type: "String", defaultValue: "ALL" },
    loadMode: { type: "String", defaultValue: "Full" },
    watermarkField: { type: "String", defaultValue: "ModifiedDateTime" },
    initialWatermark: { type: "String", defaultValue: "1970-01-01T00:00:00Z" },
    windowEnd: { type: "String", defaultValue: "" },
    safetyLagSeconds: { type: "Int", defaultValue: 120 },
    overlapSeconds: { type: "Int", defaultValue: 120 },
    cooldownSeconds: { type: "Int", defaultValue: 2 },
  };
  const fullParameters = { entity: parameters.entity, legalEntity: parameters.legalEntity };
  const clauseExpr =
    "@concat(" +
    "if(equals(pipeline().parameters.legalEntity, 'ALL'), '', concat('dataAreaId eq ''', pipeline().parameters.legalEntity, '''')), " +
    "if(and(not(equals(pipeline().parameters.legalEntity, 'ALL')), equals(pipeline().parameters.loadMode, 'Incremental')), ' and ', ''), " +
    "if(equals(pipeline().parameters.loadMode, 'Incremental'), concat(pipeline().parameters.watermarkField, ' ge ', variables('lowerBound'), " +
    "' and ', pipeline().parameters.watermarkField, ' lt ', variables('upperBound')), ''))";
  const queryExpr =
    "@concat('cross-company=true', if(empty(variables('filter')), '', concat('&$filter=', variables('filter'))), " +
    "if(equals(pipeline().parameters.loadMode, 'Incremental'), concat('&$orderby=', pipeline().parameters.watermarkField, ' asc'), ''))";

  const source = odata
    ? { type: "ODataSource", httpRequestTimeout: "00:05:00", query: expression("@variables('query')") }
    : {
      type: "RestSource", requestMethod: "GET", httpRequestTimeout: "00:05:00",
      requestInterval: "[parameters('restRequestInterval')]",
      paginationRules: { AbsoluteUrl: "$['@odata.nextLink']", supportRFC5988: "false" },
    };
  const copy = {
    name: "CopyEntity", type: "Copy", dependsOn: after("Cooldown"),
    policy: { ...clone(policy), timeout: "0.02:00:00" },
    typeProperties: {
      source,
      sink: {
        type: "JsonSink", storeSettings: { type: "AzureBlobFSWriteSettings" },
        formatSettings: { type: "JsonWriteSettings", filePattern: "arrayOfObjects" },
      },
      enableStaging: false,
    },
    inputs: [input(odata ? "@pipeline().parameters.entity" :
      "@concat('data/', pipeline().parameters.entity, '?', variables('query'))")],
    outputs: [rawOutput("@variables('outputFolder')")],
  };

  const checkpointFields = {
    PartitionKey: "@variables('partitionKey')", RowKey: "@variables('checkpointKey')",
    Watermark: "@variables('upperBound')", RunId: "@pipeline().RunId",
    OutputFolder: "@variables('outputFolder')", LowerBound: "@variables('lowerBound')",
  };
  const carrierSource = odata
    ? { type: "ODataSource", query: "$top=1&$select=LegalEntityId&cross-company=true", httpRequestTimeout: "00:02:00" }
    : { type: "RestSource", requestMethod: "GET", httpRequestTimeout: "00:02:00" };
  carrierSource.additionalColumns = Object.entries(checkpointFields).map(([name, value]) => ({ name, value: expression(value) }));
  const commit = {
    name: "CommitCheckpoint", type: "Copy", policy: clone(policy),
    typeProperties: {
      source: carrierSource,
      sink: {
        type: "AzureTableSink", azureTablePartitionKeyName: "PartitionKey", azureTableRowKeyName: "RowKey",
        azureTableInsertType: "replace", writeBatchSize: 1, maxConcurrentConnections: 1,
      },
      translator: {
        type: "TabularTranslator",
        mappings: Object.keys(checkpointFields).map(name => ({
          source: odata ? { name, type: "String" } : { path: `$['${name}']`, type: "String" },
          sink: { name, type: "String" },
        })),
      },
    },
    inputs: [input(odata ? "LegalEntities" : "data/LegalEntities?$top=1&$select=LegalEntityId&cross-company=true")],
    outputs: [{ referenceName: tableDataset, type: "DatasetReference" }],
  };
  const commitActivities = [
    commit,
    checkpointLookup("ReadCommittedCheckpoint", "CommitCheckpoint"),
    failIf("VerifyCommit",
      "@not(and(equals(activity('CommitCheckpoint').output.rowsCopied, 1), " +
      "if(equals(activity('ReadCommittedCheckpoint').output.count, 1), " +
      "and(equals(activity('ReadCommittedCheckpoint').output.value[0].Watermark, variables('upperBound')), " +
      "equals(activity('ReadCommittedCheckpoint').output.value[0].RunId, pipeline().RunId)), false)))",
      "CheckpointCommitNotConfirmed", "Checkpoint must contain exactly one row matching this run and window.", "ReadCommittedCheckpoint"),
  ];
  const commitParameters = ["partitionKey", "checkpointKey", "upperBound", "lowerBound", "outputFolder", "sourceRunId"];
  const commitJson = JSON.stringify(commitActivities)
    .replace(/variables\('([^']+)'\)/g, "pipeline().parameters.$1")
    .replaceAll("pipeline().RunId", "pipeline().parameters.sourceRunId");
  template.resources.push(resource("pipelines", commitPipeline, {
    description: "Internal commit helper; invoke only from the serialized entity pipeline after copy and output checks.",
    parameters: Object.fromEntries(commitParameters.map(name => [name, { type: "String" }])),
    activities: JSON.parse(commitJson),
  }, [["datasets", sourceDataset], ["datasets", tableDataset]]));

  const invalid =
    "or(not(contains(createArray('Full', 'Incremental'), pipeline().parameters.loadMode)), " +
    "or(or(less(pipeline().parameters.safetyLagSeconds, 0), less(pipeline().parameters.overlapSeconds, 0)), " +
    "or(or(greater(pipeline().parameters.safetyLagSeconds, 86400), greater(pipeline().parameters.overlapSeconds, 86400)), " +
    "or(or(less(pipeline().parameters.cooldownSeconds, 0), greater(pipeline().parameters.cooldownSeconds, 300)), " +
    "or(empty(pipeline().parameters.watermarkField), empty(pipeline().parameters.legalEntity))))))";
  const activities = [
    failIf("ValidateParameters", `@${invalid}`, "InvalidParameters",
      "Use Full or Incremental, lag/overlap 0..86400, cooldown 0..300 seconds, and nonempty watermarkField/legalEntity."),
    set("SetCheckpointKey", "checkpointKey", checkpointKey, "ValidateParameters"),
    set("CaptureUpperBound", "upperBound",
      `@formatDateTime(if(empty(pipeline().parameters.windowEnd), addSeconds(utcNow(), mul(-1, pipeline().parameters.safetyLagSeconds)), pipeline().parameters.windowEnd), ${tsFormat})`,
      "SetCheckpointKey"),
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
      `@formatDateTime(addSeconds(variables('committedWatermark'), mul(-1, pipeline().parameters.overlapSeconds)), ${tsFormat})`,
      "ValidateWindow"),
    set("SetFilter", "filter", clauseExpr, "SetLowerBound"),
    set("SetQuery", "query", queryExpr, "SetFilter"),
    set("SetOutputFolder", "outputFolder",
      `@concat('${rawRoot}/', pipeline().parameters.legalEntity, '/', pipeline().parameters.entity, '/', ` +
      "formatDateTime(pipeline().TriggerTime, 'yyyy/MM/dd'), '/', pipeline().RunId)", "SetQuery"),
    {
      name: "Cooldown", type: "Wait", dependsOn: after("SetOutputFolder"),
      typeProperties: { waitTimeInSeconds: expression("@pipeline().parameters.cooldownSeconds") },
    },
    copy,
    {
      name: "InspectRawOutput", type: "GetMetadata", dependsOn: after("CopyEntity"), policy: clone(policy),
      typeProperties: {
        dataset: rawOutput("@variables('outputFolder')"),
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
              name === "sourceRunId" ? "@pipeline().RunId" : `@variables('${name}')`)])),
          },
        }],
        ifFalseActivities: [],
      },
    },
  ];
  const variableNames = ["checkpointKey", "upperBound", "committedWatermark", "lowerBound", "filter", "query", "outputFolder"];
  template.resources.push(resource("pipelines", entityPipeline, {
    concurrency: 1,
    description: "Serialized full/incremental F&O extraction using cross-company OData. Incremental commits a Table checkpoint only after copy and output checks. Windows overlap; deletes are not captured.",
    parameters,
    variables: {
      ...Object.fromEntries(variableNames.map(name => [name, { type: "String" }])),
      partitionKey: { type: "String", defaultValue: partition },
    },
    activities,
  }, [["datasets", sourceDataset], ["datasets", rawDataset], ["datasets", tableDataset], ["pipelines", commitPipeline]]));

  template.resources.push(resource("pipelines", `${prefix}extract-entity-full`, {
    description: "Full-load wrapper. Full runs never change incremental checkpoints.",
    parameters: fullParameters,
    activities: [{
      name: "ExtractFull", type: "ExecutePipeline",
      typeProperties: {
        pipeline: { referenceName: entityPipeline, type: "PipelineReference" }, waitOnCompletion: true,
        parameters: {
          entity: expression("@pipeline().parameters.entity"),
          legalEntity: expression("@pipeline().parameters.legalEntity"),
          loadMode: "Full",
        },
      },
    }],
  }, [["pipelines", entityPipeline]]));

  const batch = (name, incremental) => resource("pipelines", name, {
    concurrency: 1, parameters: { entities: { type: "Array" } },
    description: "Sequential metadata-driven batch; every item enters the serialized entity pipeline.",
    activities: [{
      name: "ForEachEntity", type: "ForEach",
      typeProperties: {
        items: expression("@pipeline().parameters.entities"), isSequential: true,
        activities: [{
          name: "ExtractEntity", type: "ExecutePipeline",
          typeProperties: {
            pipeline: { referenceName: entityPipeline, type: "PipelineReference" }, waitOnCompletion: true,
            parameters: {
              entity: expression("@item().entity"), legalEntity: expression("@item().legalEntity"),
              loadMode: incremental ? expression("@item().loadMode") : "Full",
              ...(incremental ? { watermarkField: expression("@coalesce(item()?.watermarkField, 'ModifiedDateTime')") } : {}),
            },
          },
        }],
      },
    }],
  }, [["pipelines", entityPipeline]]);
  template.resources.push(batch(`${prefix}extract-batch`, true), batch(`${prefix}extract-batch-full`, false));

  const discoveryFolder = `@concat('${rawRoot}/legal-entity-discovery/', pipeline().RunId)`;
  template.resources.push(resource("pipelines", `${prefix}discover-legal-entities`, {
    description: "Lists legal entities (cross-company) to validate authorization; fails on an empty result.",
    activities: [
      {
        name: "CopyLegalEntities", type: "Copy", policy: clone(policy),
        typeProperties: {
          source: odata
            ? { type: "ODataSource", query: "$select=LegalEntityId,Name&cross-company=true", httpRequestTimeout: "00:02:00" }
            : {
              type: "RestSource", requestMethod: "GET", httpRequestTimeout: "00:02:00",
              paginationRules: { AbsoluteUrl: "$['@odata.nextLink']", supportRFC5988: "false" },
            },
          sink: {
            type: "JsonSink", storeSettings: { type: "AzureBlobFSWriteSettings" },
            formatSettings: { type: "JsonWriteSettings", filePattern: "arrayOfObjects" },
          },
        },
        inputs: [input(odata ? "LegalEntities" : "data/LegalEntities?$select=LegalEntityId,Name&cross-company=true")],
        outputs: [rawOutput(discoveryFolder)],
      },
      failIf("RequireLegalEntity", "@equals(activity('CopyLegalEntities').output.rowsCopied, 0)",
        "NoLegalEntities", "The application returned no legal entities; check the F&O user mapping and security role.", "CopyLegalEntities"),
    ],
  }, [["datasets", sourceDataset], ["datasets", rawDataset]]));

  const readDataset = {
    referenceName: rawDataset, type: "DatasetReference",
    parameters: { folderPath: expression("@pipeline().parameters.folderPath"), fileName: expression("@pipeline().parameters.fileName") },
  };
  template.resources.push(resource("pipelines", `${prefix}validate-raw-json`, {
    description: "Reads a small raw JSON file through the private runtime (Lookup limit 5000 rows / 4 MB).",
    parameters: { folderPath: { type: "String" }, fileName: { type: "String", defaultValue: "response-pages.json" } },
    activities: [
      {
        name: "InspectFile", type: "GetMetadata", policy: { timeout: "0.00:10:00", retry: 2, retryIntervalInSeconds: 30 },
        typeProperties: { dataset: readDataset, fieldList: ["exists", "size", "lastModified"], storeSettings: { type: "AzureBlobFSReadSettings", recursive: false } },
      },
      {
        name: "ReadRawFile", type: "Lookup", dependsOn: after("InspectFile"), policy: { timeout: "0.00:10:00", retry: 2, retryIntervalInSeconds: 30 },
        typeProperties: {
          source: { type: "JsonSource", storeSettings: { type: "AzureBlobFSReadSettings", recursive: false }, formatSettings: { type: "JsonReadSettings" } },
          dataset: readDataset, firstRowOnly: false,
        },
      },
    ],
  }, [["datasets", rawDataset]]));

  template.resources.push(resource("pipelines", `${prefix}read-checkpoint`, {
    description: "Read-only checkpoint inspection using the same derived key and connector-isolated partition.",
    parameters: fullParameters,
    variables: { checkpointKey: { type: "String" }, partitionKey: { type: "String", defaultValue: partition } },
    activities: [set("SetCheckpointKey", "checkpointKey", checkpointKey), checkpointLookup("ReadCheckpoint", "SetCheckpointKey")],
  }, [["datasets", tableDataset]]));

  const directory = path.join(root, variant);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "adf-pipelines.json"), JSON.stringify(template, null, 2) + "\n");
  console.log(`${variant}: ${template.resources.length} resources`);
}
