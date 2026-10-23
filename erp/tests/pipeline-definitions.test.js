const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function walk(activities, visit) {
  for (const activity of activities) {
    visit(activity);
    const props = activity.typeProperties || {};
    for (const key of ["activities", "ifTrueActivities", "ifFalseActivities"]) {
      if (props[key]) walk(props[key], visit);
    }
  }
}
for (const variant of ["rest", "odata"]) {
  const root = path.resolve(__dirname, "..");
  const file = path.join(root, variant === "odata" ? "odata" : "", "adf-pipelines.json");
  const template = JSON.parse(fs.readFileSync(file, "utf8"));
  const prefix = variant === "odata" ? "pl-odata-" : "pl-";
  const pipeline = name => template.resources.find(r =>
    r.type.endsWith("/pipelines") && r.name.endsWith(`/${prefix}${name}')]`)).properties;
  const entity = pipeline("extract-entity");
  const activities = Object.fromEntries(entity.activities.map(a => [a.name, a]));
  assert.equal(entity.concurrency, 1);
  assert.deepEqual(activities.CopyEntity.dependsOn, [{ activity: "Cooldown", dependencyConditions: ["Succeeded"] }]);
  assert.equal(activities.ValidateRawOutput.dependsOn[0].activity, "InspectRawOutput");
  assert.equal(activities.CommitIncrementalOnly.dependsOn[0].activity, "ValidateRawOutput");
  assert.equal(activities.CommitIncrementalOnly.typeProperties.expression.value,
    "@equals(pipeline().parameters.loadMode, 'Incremental')");
  assert.match(activities.SetQuery.typeProperties.value.value, /lastModifiedDateTime ge/);
  assert.match(activities.SetQuery.typeProperties.value.value, /lastModifiedDateTime lt/);
  assert.match(activities.ValidateWindow.typeProperties.expression.value, /lessOrEquals/);
  assert.match(entity.variables.partitionKey.defaultValue, new RegExp(`\\|${variant}`));
  const commit = pipeline("commit-checkpoint");
  assert.equal(commit.activities[0].typeProperties.sink.azureTableInsertType, "replace");
  assert.equal(commit.activities[0].typeProperties.sink.writeBatchSize, 1);
  assert.equal(commit.activities[1].dependsOn[0].activity, "CommitCheckpoint");
  assert.equal(pipeline("extract-batch").activities[0].typeProperties.isSequential, true);
  assert.equal(pipeline("extract-entity-full").activities[0].typeProperties.parameters.loadMode, "Full");
  if (variant === "odata") {
    assert.equal(commit.activities[0].inputs[0].parameters.apiPath, "api/v2.0");
    assert.equal(activities.CopyEntity.typeProperties.source.type, "ODataSource");
    assert.equal(entity.parameters.pageSize, undefined);
    assert.equal(activities.CopyEntity.typeProperties.source.paginationRules, undefined);
  } else {
    assert.equal(activities.CopyEntity.typeProperties.source.type, "RestSource");
    assert.equal(activities.CopyEntity.typeProperties.source.paginationRules.AbsoluteUrl, "$['@odata.nextLink']");
    assert.match(activities.ValidateParameters.typeProperties.expression.value, /greater\(pipeline\(\).parameters.pageSize, 20000\)/);
  }
  for (const resource of template.resources.filter(r => r.type.endsWith("/pipelines"))) {
    const available = new Set();
    walk(resource.properties.activities, a => available.add(a.name));
    walk(resource.properties.activities, activity => {
      for (const dependency of activity.dependsOn || []) assert(available.has(dependency.activity));
      if (activity.type === "IfCondition") {
        for (const child of [...activity.typeProperties.ifTrueActivities, ...activity.typeProperties.ifFalseActivities]) {
          assert.notEqual(child.type, "IfCondition", "ADF does not support directly nested IfCondition activities");
        }
      }
    });
  }
  console.log(`PASS ${variant}: connector types, bounded windows, serialized entrypoint, commit ordering, and dependencies`);
}
