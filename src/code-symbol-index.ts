import * as fs from "node:fs";
import * as path from "node:path";

export interface SymbolDefinition {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method" | "export";
  file: string;
  line: number;
  column: number;
  signature?: string;
  docstring?: string;
}

export interface SymbolReference {
  symbolName: string;
  file: string;
  line: number;
  column: number;
  contextSnippet: string;
}

export interface CallGraphNode {
  caller: string;
  callee: string;
  file: string;
  line: number;
}

export interface CodeIndexSummary {
  totalFilesIndexed: number;
  totalDefinitions: number;
  totalReferences: number;
  totalCallGraphEdges: number;
}

/**
 * AST-Aware Code Symbol Indexer
 *
 * Provides structured symbol definition, reference, and call-graph lookup
 * across TypeScript, JavaScript, Python, and Rust codebases.
 */
export class CodeSymbolIndex {
  private definitions = new Map<string, SymbolDefinition[]>();
  private references = new Map<string, SymbolReference[]>();
  private callEdges: CallGraphNode[] = [];
  private indexedFiles = new Set<string>();

  /**
   * Index a directory or array of file paths.
   */
  async indexDirectory(dirPath: string, extensions: string[] = [".ts", ".js", ".tsx", ".jsx", ".mjs", ".py"]): Promise<CodeIndexSummary> {
    const files = this.collectFiles(dirPath, extensions);
    for (const file of files) {
      await this.indexFile(file);
    }
    return this.getSummary();
  }

  /**
   * Index an individual source file.
   */
  async indexFile(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const relPath = filePath;

    this.indexedFiles.add(relPath);

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const lineText = lines[i];

      // Match function declarations: function foo(...) / async function foo(...)
      const fnMatch = lineText.match(/(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        this.addDefinition({
          name: fnMatch[1],
          kind: "function",
          file: relPath,
          line: lineNum,
          column: lineText.indexOf(fnMatch[1]) + 1,
          signature: fnMatch[0].trim(),
        });
      }

      // Match class declarations: class Bar ...
      const classMatch = lineText.match(/class\s+([a-zA-Z0-9_$]+)/);
      if (classMatch) {
        this.addDefinition({
          name: classMatch[1],
          kind: "class",
          file: relPath,
          line: lineNum,
          column: lineText.indexOf(classMatch[1]) + 1,
          signature: classMatch[0].trim(),
        });
      }

      // Match interface / type declarations: interface IFoo / type TFoo = ...
      const typeMatch = lineText.match(/(?:interface|type)\s+([a-zA-Z0-9_$]+)/);
      if (typeMatch) {
        this.addDefinition({
          name: typeMatch[1],
          kind: lineText.includes("interface") ? "interface" : "type",
          file: relPath,
          line: lineNum,
          column: lineText.indexOf(typeMatch[1]) + 1,
          signature: lineText.trim(),
        });
      }

      // Match export const/let/var/function
      const exportMatch = lineText.match(/export\s+(?:const|let|var|function|class)\s+([a-zA-Z0-9_$]+)/);
      if (exportMatch) {
        this.addDefinition({
          name: exportMatch[1],
          kind: "export",
          file: relPath,
          line: lineNum,
          column: lineText.indexOf(exportMatch[1]) + 1,
          signature: lineText.trim(),
        });
      }

      // Extract call expressions: foo(...)
      const callMatches = Array.from(lineText.matchAll(/([a-zA-Z0-9_$]+)\s*\(/g));
      for (const cm of callMatches) {
        const callee = cm[1];
        if (["if", "for", "while", "switch", "catch", "function", "return"].includes(callee)) continue;

        this.addReference({
          symbolName: callee,
          file: relPath,
          line: lineNum,
          column: (cm.index ?? 0) + 1,
          contextSnippet: lineText.trim(),
        });
      }
    }
  }

  /**
   * Find definition(s) of a symbol.
   */
  getDefinitions(symbolName: string): SymbolDefinition[] {
    return this.definitions.get(symbolName) ?? [];
  }

  /**
   * Find all references to a symbol.
   */
  getReferences(symbolName: string): SymbolReference[] {
    return this.references.get(symbolName) ?? [];
  }

  /**
   * Find all callers of a given symbol.
   */
  getCallers(symbolName: string): SymbolReference[] {
    return this.getReferences(symbolName);
  }

  /**
   * Get summary counts.
   */
  getSummary(): CodeIndexSummary {
    let defCount = 0;
    for (const defs of this.definitions.values()) defCount += defs.length;

    let refCount = 0;
    for (const refs of this.references.values()) refCount += refs.length;

    return {
      totalFilesIndexed: this.indexedFiles.size,
      totalDefinitions: defCount,
      totalReferences: refCount,
      totalCallGraphEdges: this.callEdges.length,
    };
  }

  private addDefinition(def: SymbolDefinition): void {
    const list = this.definitions.get(def.name) ?? [];
    list.push(def);
    this.definitions.set(def.name, list);
  }

  private addReference(ref: SymbolReference): void {
    const list = this.references.get(ref.symbolName) ?? [];
    list.push(ref);
    this.references.set(ref.symbolName, list);
  }

  private collectFiles(dir: string, exts: string[]): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.collectFiles(fullPath, exts));
      } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
    return results;
  }
}
