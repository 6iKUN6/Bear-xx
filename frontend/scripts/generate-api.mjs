import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import ejs from "ejs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "..");
const backendRoot = path.resolve(frontendRoot, "..", "backend");
const templatePath = path.resolve(
  frontendRoot,
  "src/api/template/api-client.ejs",
);
const openApiPath = path.resolve(backendRoot, "docs/openapi.json");
const outputPath = path.resolve(frontendRoot, "src/api/generated.ts");

main();

function main() {
  exportBackendOpenApi();

  const document = JSON.parse(fs.readFileSync(openApiPath, "utf8"));
  const schemasCode = renderSchemas(document.components?.schemas || {});
  const methods = buildMethods(document.paths || {});
  const template = fs.readFileSync(templatePath, "utf8");
  const rendered = ejs.render(template, { schemasCode, methods }, { rmWhitespace: false });

  fs.writeFileSync(outputPath, `${rendered.trim()}\n`);
  console.log(`Generated ${path.relative(frontendRoot, outputPath)}`);
}

function exportBackendOpenApi() {
  const exportScript = path.resolve(backendRoot, "scripts/export-openapi.cjs");
  execFileSync("node", [exportScript], {
    cwd: frontendRoot,
    stdio: "inherit",
  });
}

function renderSchemas(schemas) {
  const names = Object.keys(schemas).sort();
  if (names.length === 0) {
    return "export type EmptySchemaMap = never;\n";
  }

  return names
    .map((name) => {
      const schema = schemas[name];
      const tsType = schemaToTs(schema);
      return `export type ${safeTypeName(name)} = ${tsType};`;
    })
    .join("\n\n");
}

function buildMethods(paths) {
  const methods = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"];

  for (const apiPath of Object.keys(paths).sort()) {
    const pathItem = paths[apiPath];

    for (const httpMethod of httpMethods) {
      const operation = pathItem?.[httpMethod];
      if (!operation) {
        continue;
      }

      const parameters = mergeParameters(pathItem.parameters, operation.parameters);
      const pathParams = parameters.filter((item) => item.in === "path");
      const queryParams = parameters.filter((item) => item.in === "query");
      const requestBody = getRequestBody(operation);
      const isStream = isStreamOperation(operation, apiPath);
      const isMultipart = requestBody?.contentType === "multipart/form-data";
      const methodName = toMethodName(operation, httpMethod, apiPath);
      const responseType = isStream ? "unknown" : getResponseType(operation);
      const summary = operation.summary || operation.description || "";

      methods.push({
        code: renderMethodCode({
          methodName,
          summary,
          httpMethod: httpMethod.toUpperCase(),
          apiPath,
          pathParams,
          queryParams,
          requestBody,
          responseType,
          isStream,
          isMultipart,
        }),
      });
    }
  }

  return methods;
}

function renderMethodCode(config) {
  const {
    methodName,
    summary,
    httpMethod,
    apiPath,
    pathParams,
    queryParams,
    requestBody,
    responseType,
    isStream,
    isMultipart,
  } = config;

  const argsEntries = [];
  const pathParamAssignments = [];
  const queryParamAssignments = [];
  let bodyParamSignature = null;

  for (const param of pathParams) {
    const optional = !param.required;
    const name = safePropName(param.name);
    const tsType = schemaToTs(param.schema);
    argsEntries.push(`${name}${optional ? "?" : ""}: ${tsType};`);
    pathParamAssignments.push(`${name}: args.${name}`);
  }

  for (const param of queryParams) {
    const optional = !param.required;
    const name = safePropName(param.name);
    const tsType = schemaToTs(param.schema);
    argsEntries.push(`${name}${optional ? "?" : ""}: ${tsType};`);
    queryParamAssignments.push(`${name}: args.${name}`);
  }

  let bodyExpression = null;
  if (requestBody?.tsType) {
    if (isMultipart) {
      argsEntries.push("body?: " + requestBody.tsType + ";");
      argsEntries.push("filePath: string;");
      argsEntries.push("fileFieldName?: string;");
    } else {
      const bodyOptional = requestBody.required ? "" : "?";
      if (argsEntries.length === 0) {
        bodyExpression = "body";
        bodyParamSignature = `body${bodyOptional}: ${requestBody.tsType}`;
      } else {
        argsEntries.push(`body${bodyOptional}: ${requestBody.tsType};`);
        bodyExpression = "args.body";
      }
    }
  }

  const needsArgs = argsEntries.length > 0;
  const argsType = needsArgs
    ? `{\n${indent(argsEntries.join("\n"), 4)}\n  }`
    : "";

  const signatureParts = [];
  if (bodyParamSignature) {
    signatureParts.push(bodyParamSignature);
  } else if (needsArgs) {
    signatureParts.push(`args: ${argsType}`);
  }
  if (isStream) {
    signatureParts.push("handlers: StreamHandlers<unknown> = {}");
  }
  const signature = signatureParts.join(", ");

  const requestOptions = [
    `url: ${JSON.stringify(apiPath)}`,
    `method: ${JSON.stringify(httpMethod)}`,
  ];

  if (pathParamAssignments.length > 0) {
    requestOptions.push(`pathParams: {\n${indent(pathParamAssignments.join(",\n"), 6)}\n    }`);
  }

  if (queryParamAssignments.length > 0) {
    requestOptions.push(`query: {\n${indent(queryParamAssignments.join(",\n"), 6)}\n    }`);
  }

  if (requestBody?.tsType) {
    if (isMultipart) {
      requestOptions.push("filePath: args.filePath");
      requestOptions.push(
        `name: args.fileFieldName || ${JSON.stringify(
          getDefaultFileFieldName(apiPath, requestBody.fileFieldName),
        )}`,
      );
      requestOptions.push("formData: args.body");
    } else {
      requestOptions.push(`data: ${bodyExpression}`);
    }
  }

  const methodDoc = summary
    ? `  /**\n   * ${escapeComment(summary)}\n   */\n`
    : "";

  const requestCall = isMultipart
    ? `this.upload<${responseType}${requestBody?.tsType ? `, ${requestBody.tsType}` : ""}>`
    : isStream
      ? `this.stream<unknown${requestBody?.tsType ? `, ${requestBody.tsType}` : ""}>`
      : `this.request<${responseType}${requestBody?.tsType ? `, ${requestBody.tsType}` : ""}>`;

  const returnType = isStream
    ? "StreamRequestHandle"
    : `Promise<${responseType}>`;

  const requestConfigBlock = `{\n${indent(requestOptions.join(",\n"), 6)}\n    }`;
  const requestExpression = isStream
    ? `${requestCall}(${requestConfigBlock}, handlers)`
    : `${requestCall}(${requestConfigBlock})`;

  return `${methodDoc}  ${methodName}(${signature})${isStream ? ": " : ": "}${returnType} {\n    return ${requestExpression};\n  }`;
}

function mergeParameters(pathLevel = [], operationLevel = []) {
  const merged = [...pathLevel];

  for (const parameter of operationLevel) {
    const existingIndex = merged.findIndex(
      (item) => item.name === parameter.name && item.in === parameter.in,
    );
    if (existingIndex >= 0) {
      merged[existingIndex] = parameter;
    } else {
      merged.push(parameter);
    }
  }

  return merged;
}

function getRequestBody(operation) {
  const content = operation.requestBody?.content;
  if (!content) {
    return null;
  }

  if (content["application/json"]) {
    return {
      contentType: "application/json",
      tsType: schemaToTs(content["application/json"].schema),
      required: !!operation.requestBody.required,
    };
  }

  if (content["multipart/form-data"]) {
    return {
      contentType: "multipart/form-data",
      tsType: schemaToTs(content["multipart/form-data"].schema),
      required: !!operation.requestBody.required,
      fileFieldName: detectFileFieldName(content["multipart/form-data"].schema),
    };
  }

  const firstContentType = Object.keys(content)[0];
  if (!firstContentType) {
    return null;
  }

  return {
    contentType: firstContentType,
    tsType: schemaToTs(content[firstContentType].schema),
    required: !!operation.requestBody.required,
  };
}

function detectFileFieldName(schema) {
  if (!schema) {
    return undefined;
  }

  if (schema.$ref) {
    return undefined;
  }

  for (const [name, property] of Object.entries(schema.properties || {})) {
    if (property?.type === "string" && property?.format === "binary") {
      return name;
    }
  }

  return undefined;
}

function getDefaultFileFieldName(apiPath, detectedFileFieldName) {
  if (detectedFileFieldName) {
    return detectedFileFieldName;
  }

  if (apiPath.endsWith("/voice-completions")) {
    return "audio";
  }

  return "file";
}

function getResponseType(operation) {
  const responses = operation.responses || {};
  const successResponse =
    responses["200"] ||
    responses["201"] ||
    responses["202"] ||
    responses.default;

  if (!successResponse?.content) {
    return "unknown";
  }

  const jsonContent =
    successResponse.content["application/json"] ||
    successResponse.content["text/plain"] ||
    successResponse.content["*/*"];

  if (!jsonContent?.schema) {
    return "unknown";
  }

  return schemaToTs(jsonContent.schema);
}

function isStreamOperation(operation, apiPath) {
  const responses = operation.responses || {};

  if (/\/sse-tasks\/\{[^}]+\}\/(stream|resume)$/.test(apiPath)) {
    return true;
  }

  return Object.values(responses).some((response) =>
    Object.prototype.hasOwnProperty.call(
      response?.content || {},
      "text/event-stream",
    ),
  );
}

function toMethodName(operation, httpMethod, apiPath) {
  if (operation.operationId) {
    const segments = operation.operationId.split("_").filter(Boolean);
    const preferredName =
      segments.length > 1 ? segments[segments.length - 1] : operation.operationId;
    return normalizeMethodName(preferredName);
  }

  const segments = apiPath
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? `by-${segment.slice(1, -1)}`
        : segment,
    );

  return normalizeMethodName([httpMethod, ...segments].join("-"));
}

function normalizeMethodName(input) {
  const cleaned = input
    .replace(/Controller[_-]?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/[:/]/g, "-");

  const words = cleaned
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .flatMap(splitCamelCase);

  if (words.length === 0) {
    return "callApi";
  }

  const [first, ...rest] = words;
  return first.toLowerCase() + rest.map(capitalize).join("");
}

function schemaToTs(schema) {
  if (!schema) {
    return "unknown";
  }

  if (schema.$ref) {
    return safeTypeName(getRefName(schema.$ref));
  }

  if (schema.enum) {
    const values = schema.enum.map((item) => JSON.stringify(item)).join(" | ");
    return schema.nullable ? `${values} | null` : values;
  }

  if (schema.oneOf) {
    return wrapNullable(
      schema.oneOf.map((item) => schemaToTs(item)).join(" | "),
      schema.nullable,
    );
  }

  if (schema.anyOf) {
    return wrapNullable(
      schema.anyOf.map((item) => schemaToTs(item)).join(" | "),
      schema.nullable,
    );
  }

  if (schema.allOf) {
    return wrapNullable(
      schema.allOf.map((item) => schemaToTs(item)).join(" & "),
      schema.nullable,
    );
  }

  if (Array.isArray(schema.type)) {
    return schema.type
      .map((item) => schemaToTs({ ...schema, type: item }))
      .join(" | ");
  }

  if (schema.type === "array") {
    return wrapNullable(`Array<${schemaToTs(schema.items)}>` , schema.nullable);
  }

  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const required = new Set(schema.required || []);
    const fields = Object.entries(schema.properties || {}).map(([name, value]) => {
      const optional = required.has(name) ? "" : "?";
      return `${safePropName(name)}${optional}: ${schemaToTs(value)};`;
    });

    if (schema.additionalProperties) {
      fields.push(
        `[key: string]: ${schema.additionalProperties === true ? "unknown" : schemaToTs(schema.additionalProperties)};`,
      );
    }

    if (fields.length === 0) {
      return wrapNullable("Record<string, unknown>", schema.nullable);
    }

    return wrapNullable(`{\n${indent(fields.join("\n"), 2)}\n}`, schema.nullable);
  }

  switch (schema.type) {
    case "string":
      return wrapNullable("string", schema.nullable);
    case "integer":
    case "number":
      return wrapNullable("number", schema.nullable);
    case "boolean":
      return wrapNullable("boolean", schema.nullable);
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function getRefName(ref) {
  return ref.split("/").pop() || "UnknownRef";
}

function safeTypeName(name) {
  const normalized = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (/^[0-9]/.test(normalized)) {
    return `Schema_${normalized}`;
  }
  return normalized;
}

function safePropName(name) {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return name;
  }
  return JSON.stringify(name);
}

function wrapNullable(typeText, nullable) {
  return nullable ? `${typeText} | null` : typeText;
}

function indent(text, spaces) {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : line))
    .join("\n");
}

function splitCamelCase(word) {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function escapeComment(text) {
  return text.replace(/\*\//g, "* /");
}
