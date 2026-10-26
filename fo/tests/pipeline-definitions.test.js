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
  const file = path.resolve(__dirname, "..", variant, "adf-pipelines.json");
  const template = JSON.parse(fs.readFileSync(file, "utf8"));
  const prefix = variant === "odata" ? "pl-fo-odata-" : "pl-fo-";
  const pipeline = name => template.resources.find(r =>
    r.type.endsWith("/pipelines") && r.name.endsWith(`/${prefix}${name}')]`)).properties;
  const entity = pipeline("extract-entity");
  const activities = Object.fromEntries(entity.activities.map(a => [a.name, a]));
  assert.equal(entity.concurrency, 1);
  assert.deepEqual(activities.CopyEntity.dependsOn, [{ activity: "Cooldown", dependencyConditions: ["Succeeded"] }]);
  assert.equal(activities.CommitIncrementalOnly.dependsOn[0].activity, "ValidateRawOutput");
  assert.match(activities.SetFilter.typeProperties.value.value, /watermarkField, ' ge '/);
  assert.match(activities.SetQuery.typeProperties.value.value, /cross-company=true/);
  assert.match(activities.SetOutputFolder.typeProperties.value.value, /dynamics-fo\//);
  assert.match(entity.variables.partitionKey.defaultValue, new RegExp(`\\|${variant}`));
  assert.equal(entity.parameters.watermarkField.defaultValue, "ModifiedDateTime");
  const commit = pipeline("commit-checkpoint");
  assert.equal(commit.activities[0].typeProperties.sink.azureTableInsertType, "replace");
  assert.equal(commit.activities[1].dependsOn[0].activity, "CommitCheckpoint");
  assert.equal(pipeline("extract-batch").activities[0].typeProperties.isSequential, true);
  assert.equal(pipeline("extract-entity-full").activities[0].typeProperties.parameters.loadMode, "Full");
  const source = activities.CopyEntity.typeProperties.source;
  if (variant === "odata") {
    assert.equal(source.type, "ODataSource");
    assert.equal(source.paginationRules, undefined);
  } else {
    assert.equal(source.type, "RestSource");
    assert.equal(source.paginationRules.AbsoluteUrl, "$['@odata.nextLink']");
  }
  const text = JSON.stringify(template);
  assert(!/businesscentral|bc-extraction|BcExtraction/i.test(text), "no Business Central identifiers");
  for (const resource of template.resources.filter(r => r.type.endsWith("/pipelines"))) {
    const names = new Set();
    walk(resource.properties.activities, a => names.add(a.name));
    walk(resource.properties.activities, activity => {
      for (const dependency of activity.dependsOn || []) assert(names.has(dependency.activity));
      if (activity.type === "IfCondition") {
        for (const child of [...activity.typeProperties.ifTrueActivities, ...activity.typeProperties.ifFalseActivities]) {
          assert.notEqual(child.type, "IfCondition");
        }
      }
    });
  }
  console.log(`PASS ${variant}`);
}
