import { type EmitContext, emitFile, type Model, type Type } from "@typespec/compiler";
import {
  collectServices,
  type BaseEmitterOptions,
  type EnumInfo,
  type FieldInfo,
  type UnionInfo,
  type UnionVariantInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  isUnionType,
  arrayElementType,
  recordElementType,
  toSnakeCase,
  dottedPathToPascalCase,
  checkAndReportReservedKeywords,
  safeFieldName,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToScala(type: Type): string {
  if (isArrayType(type)) return `Seq[${typeToScala(arrayElementType(type)!)}]`;
  if (isRecordType(type)) return `Map[String, ${typeToScala(recordElementType(type)!)}]`;
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return "String";
      case "boolean":
        return "Boolean";
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        return "Int";
      case "int64":
        return "Long";
      case "uint8":
      case "uint16":
      case "uint32":
      case "uint64":
        return "Long";
      case "float32":
        return "Float";
      case "float64":
      case "float":
      case "decimal":
        return "Double";
      case "bytes":
        return "Array[Byte]";
    }
  }
  if (type.kind === "Enum") return "String";
  if (isUnionType(type)) return (type as any).name || "Any";
  if (type.kind === "Model") return (type as Model).name || "Any";
  return "Any";
}

function defaultValue(type: Type): string {
  if (isArrayType(type)) return "Seq.empty";
  if (isRecordType(type)) return "Map.empty";
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return '""';
      case "boolean":
        return "false";
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        return "0";
      case "int64":
        return "0L";
      case "uint8":
      case "uint16":
      case "uint32":
        return "0L";
      case "uint64":
        return "0L";
      case "float32":
        return "0.0f";
      case "float64":
      case "float":
      case "decimal":
        return "0.0";
      case "bytes":
        return "Array.emptyByteArray";
    }
  }
  if (type.kind === "Enum") return '""';
  if (isUnionType(type) && (type as any).name) return `${(type as any).name}Undefined`;
  if (type.kind === "Model" && (type as Model).name) return `${(type as Model).name}()`;
  return "???";
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    return [
      `${w}.beginArray(${expr}.length)`,
      `${expr}.foreach { item => ${w}.nextElement(); ${writeExpr("item", elem, w)} }`,
      `${w}.endArray()`,
    ].join("\n        ");
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return [
      `${w}.beginObject(${expr}.size)`,
      `${expr}.foreach { case (k, v) => ${w}.writeField(k); ${writeExpr("v", elem, w)} }`,
      `${w}.endObject()`,
    ].join("\n        ");
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return `${w}.writeString(${expr})`;
      case "boolean":
        return `${w}.writeBool(${expr})`;
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        return `${w}.writeInt32(${expr})`;
      case "int64":
        return `${w}.writeInt64(${expr})`;
      case "uint8":
      case "uint16":
      case "uint32":
        return `${w}.writeUint32(${expr})`;
      case "uint64":
        return `${w}.writeUint64(${expr})`;
      case "float32":
        return `${w}.writeFloat32(${expr})`;
      case "float64":
      case "float":
      case "decimal":
        return `${w}.writeFloat64(${expr})`;
      case "bytes":
        return `${w}.writeBytes(${expr})`;
    }
  }
  if (type.kind === "Enum") return `${w}.writeString(${expr}.toString)`;
  if (isUnionType(type) && (type as any).name) return `write${(type as any).name}(w, ${expr})`;
  if (type.kind === "Model" && (type as Model).name) return `write${(type as Model).name}(w, ${expr})`;
  return `// TODO: unknown type`;
}

function readExpr(type: Type, r: string, optional?: boolean): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    const scalaElem = typeToScala(elem);
    const inner = [
      `val list = scala.collection.mutable.ArrayBuffer[${scalaElem}]()`,
      `${r}.beginArray()`,
      `while (${r}.hasNextElement()) { list += ${readExpr(elem, r)} }`,
      `${r}.endArray()`,
      `list.toSeq`,
    ].join("; ");
    const expr = `{ ${inner} }`;
    return optional ? `Some(${expr})` : expr;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    const scalaElem = typeToScala(elem);
    const inner = [
      `val map = scala.collection.mutable.Map[String, ${scalaElem}]()`,
      `${r}.beginObject()`,
      `while (${r}.hasNextField()) { val key = ${r}.readFieldName(); map(key) = ${readExpr(elem, r)} }`,
      `${r}.endObject()`,
      `map.toMap`,
    ].join("; ");
    const expr = `{ ${inner} }`;
    return optional ? `Some(${expr})` : expr;
  }
  const n = scalarName(type);
  if (n) {
    let base: string;
    switch (n) {
      case "string":
        base = `${r}.readString()`; break;
      case "boolean":
        base = `${r}.readBool()`; break;
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        base = `${r}.readInt32()`; break;
      case "int64":
        base = `${r}.readInt64()`; break;
      case "uint8":
      case "uint16":
      case "uint32":
        base = `${r}.readUint32().toLong`; break;
      case "uint64":
        base = `${r}.readUint64()`; break;
      case "float32":
        base = `${r}.readFloat32()`; break;
      case "float64":
      case "float":
      case "decimal":
        base = `${r}.readFloat64()`; break;
      case "bytes":
        base = `${r}.readBytes()`; break;
      default:
        base = `null.asInstanceOf[Nothing]`;
    }
    return optional ? `Some(${base})` : base;
  }
  if (type.kind === "Model" && (type as Model).name) {
    const decodeCall = `${(type as Model).name}Codec.decode.apply(${r})`;
    if (optional) return `if (${r}.isNull()) { ${r}.readNull(); None } else { Some(${decodeCall}) }`;
    return decodeCall;
  }
  if (type.kind === "Enum") {
    const base = `${r}.readString()`;
    return optional ? `Some(${base})` : base;
  }
  if (isUnionType(type) && (type as any).name) {
    const decodeCall = `${(type as any).name}Codec.decode.apply(${r})`;
    if (optional) return `if (${r}.isNull()) { ${r}.readNull(); None } else { Some(${decodeCall}) }`;
    return decodeCall;
  }
  return `???`;
}

function generateEnumCode(e: EnumInfo): string {
  const lines: string[] = [];
  lines.push(`enum ${e.name}(val value: Int):`);
  for (const m of e.members) {
    lines.push(`  case ${m.name} extends ${e.name}(${m.value})`);
  }
  return lines.join("\n");
}

function generateModelCode(m: Model, _pkg: string): string {
  const fields = extractFields(m);
  const optionalFields = fields.filter((f) => f.optional);
  const requiredFields = fields.filter((f) => !f.optional);
  const scalaField = (f: FieldInfo) => safeFieldName("scala", toSnakeCase(f.name));
  const lines: string[] = [];

  lines.push(`case class ${m.name}(`);
  const allFields = [...requiredFields, ...optionalFields];
  for (let i = 0; i < allFields.length; i++) {
    const f = allFields[i];
    const comma = i < allFields.length - 1 ? "," : "";
    if (f.optional) {
      lines.push(`  ${scalaField(f)}: Option[${typeToScala(f.type)}] = None${comma}`);
    } else {
      lines.push(`  ${scalaField(f)}: ${typeToScala(f.type)} = ${defaultValue(f.type)}${comma}`);
    }
  }
  lines.push(`)`);
  lines.push(``);
  lines.push(`def write${m.name}(w: SpecWriter, obj: ${m.name}): Unit = {`);
  if (optionalFields.length > 0) {
    lines.push(`  var fieldCount = ${requiredFields.length}`);
    for (const f of optionalFields) {
      lines.push(`  obj.${scalaField(f)}.foreach { _ => fieldCount += 1 }`);
    }
    lines.push(`  w.beginObject(fieldCount)`);
  } else {
    lines.push(`  w.beginObject(${fields.length})`);
  }
  for (const f of fields) {
    if (f.optional) {
      lines.push(`  obj.${scalaField(f)}.foreach { v => w.writeField("${f.name}"); ${writeExpr("v", f.type, "w")} }`);
    } else {
      lines.push(`  w.writeField("${f.name}"); ${writeExpr(`obj.${scalaField(f)}`, f.type, "w")}`);
    }
  }
  lines.push(`  w.endObject()`);
  lines.push(`}`);

  lines.push(``);
  lines.push(`def decode${m.name}(r: SpecReader): ${m.name} = {`);
  for (const f of fields) {
    const fld = toSnakeCase(f.name);
    if (isUnionType(f.type) && !f.optional) {
      lines.push(`  var ${fld}Val: ${typeToScala(f.type)} = ${defaultValue(f.type)}`);
    } else if (f.optional) {
      lines.push(`  var ${fld}Val: Option[${typeToScala(f.type)}] = None`);
    } else if (isModelType(f.type)) {
      lines.push(`  var ${fld}Val: ${typeToScala(f.type)} = ${defaultValue(f.type)}`);
    } else {
      lines.push(`  var ${fld}Val: ${typeToScala(f.type)} = ${defaultValue(f.type)}`);
    }
  }
  lines.push(`  r.beginObject()`);
  lines.push(`  while (r.hasNextField()) {`);
  lines.push(`    r.readFieldName() match {`);
  for (const f of fields) {
    const fld = toSnakeCase(f.name);
    const rExpr = readExpr(f.type, "r", f.optional);
    lines.push(`      case "${f.name}" => ${fld}Val = ${rExpr}`);
  }
  lines.push(`      case _ => r.skip()`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  r.endObject()`);
  const ctorArgs = allFields
    .map((f) => {
      const fld = toSnakeCase(f.name);
      return `${scalaField(f)} = ${fld}Val`;
    })
    .join(", ");
  lines.push(`  ${m.name}(${ctorArgs})`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`val ${m.name}Codec = SpecCodec[${m.name}](encode = write${m.name}, decode = decode${m.name})`);

  return lines.join("\n");
}

function generateUnionCode(u: UnionInfo, L: string[]): void {
  const unionName = u.name;
  const variantName = (v: UnionVariantInfo) => unionName + v.name.charAt(0).toUpperCase() + v.name.slice(1);

  L.push(`sealed trait ${unionName}`);
  for (const v of u.variants) {
    const vn = variantName(v);
    L.push(`case class ${vn}(value: ${typeToScala(v.type)}) extends ${unionName}`);
  }
  L.push(`case object ${unionName}Undefined extends ${unionName}`);
  L.push(``);

  L.push(`def write${unionName}(w: SpecWriter, obj: ${unionName}): Unit = {`);
  L.push(`  w.beginObject(1)`);
  L.push(`  obj match {`);
  for (const v of u.variants) {
    const vn = variantName(v);
    L.push(`    case ${vn}(v) => w.writeField("${v.name}"); ${writeExpr("v", v.type, "w")}`);
  }
  L.push(`    case ${unionName}Undefined => throw new IllegalArgumentException("cannot encode Undefined for ${unionName}")`);
  L.push(`  }`);
  L.push(`  w.endObject()`);
  L.push(`}`);

  L.push(``);
  L.push(`def decode${unionName}(r: SpecReader): ${unionName} = {`);
  L.push(`  r.beginObject()`);
  L.push(`  if (!r.hasNextField()) { r.endObject(); throw new IllegalArgumentException("empty union") }`);
  L.push(`  val field = r.readFieldName()`);
  L.push(`  val result: ${unionName} = field match {`);
  for (const v of u.variants) {
    const vn = variantName(v);
    L.push(`    case "${v.name}" => ${vn}(${readExpr(v.type, "r")})`);
  }
  L.push(`    case _ => throw new IllegalArgumentException(s"unknown variant $$field")`);
  L.push(`  }`);
  L.push(`  while (r.hasNextField()) { r.readFieldName(); r.skip() }`);
  L.push(`  r.endObject()`);
  L.push(`  result`);
  L.push(`}`);
  L.push(``);
  L.push(`val ${unionName}Codec = SpecCodec[${unionName}](encode = write${unionName}, decode = decode${unionName})`);
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  const modelNs = new Map<string, string>();
  for (const s of services) {
    for (const m of s.models) { if (m.name) modelNs.set(m.name, s.serviceName); }
    for (const e of s.enums) { if (e.name) modelNs.set(e.name, s.serviceName); }
    for (const u of s.unions) { if (u.name) modelNs.set(u.name, s.serviceName); }
  }

  for (const svc of services) {
    const pkg = dottedPathToPascalCase(svc.serviceName);
    const lines: string[] = [];

    const xrefNs = new Set<string>();
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const f of extractFields(m)) {
        const collectX = (t: Type) => {
          if ((t.kind === "Model" || t.kind === "Enum") && (t as any).name) {
            const ns = modelNs.get((t as any).name);
            if (ns && ns !== svc.serviceName) xrefNs.add(ns);
          }
          if (isArrayType(t)) collectX(arrayElementType(t)!);
          if (isRecordType(t)) collectX(recordElementType(t)!);
        };
        collectX(f.type);
      }
    }
    for (const u of svc.unions) {
      for (const v of u.variants) {
        const collectX = (t: Type) => {
          if ((t.kind === "Model" || t.kind === "Enum") && (t as any).name) {
            const ns = modelNs.get((t as any).name);
            if (ns && ns !== svc.serviceName) xrefNs.add(ns);
          }
          if (isArrayType(t)) collectX(arrayElementType(t)!);
          if (isRecordType(t)) collectX(recordElementType(t)!);
        };
        collectX(v.type);
      }
    }

    lines.push("// Generated by @specodec/typespec-emitter-scala. DO NOT EDIT.");
    lines.push(`package ${pkg}`);
    lines.push(``);
    lines.push(`import specodec._`);
    for (const ns of [...xrefNs].sort()) {
      lines.push(`import ${dottedPathToPascalCase(ns)}._`);
    }
    lines.push(``);
    for (const e of svc.enums) {
      if (!e.name) continue;
      lines.push(generateEnumCode(e));
      lines.push(``);
    }
    for (const m of svc.models) {
      if (!m.name) continue;
      lines.push(generateModelCode(m, pkg));
      lines.push(``);
    }
    for (const u of svc.unions) {
      generateUnionCode(u, lines);
      lines.push(``);
    }
    const fileName = `${dottedPathToPascalCase(svc.serviceName)}Types.scala`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
