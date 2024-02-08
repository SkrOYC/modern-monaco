/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) X. <i@jex.me>
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type ts from "typescript";
import type {
  CancellationToken,
  editor,
  IDisposable,
  IEvent,
  IRange,
  languages,
  MarkerSeverity,
  MarkerTag,
  Position,
  Range,
  Uri,
} from "monaco-editor-core";
import type {
  Diagnostic,
  DiagnosticRelatedInformation,
  ExtraLib,
  TypeScriptWorker,
} from "./worker";

let M = {} as unknown as typeof import("monaco-editor-core");
export function preclude(monaco: typeof M) {
  const { SymbolKind } = monaco.languages;
  outlineTypeTable[Kind.module] = SymbolKind.Module;
  outlineTypeTable[Kind.class] = SymbolKind.Class;
  outlineTypeTable[Kind.enum] = SymbolKind.Enum;
  outlineTypeTable[Kind.interface] = SymbolKind.Interface;
  outlineTypeTable[Kind.memberFunction] = SymbolKind.Method;
  outlineTypeTable[Kind.memberVariable] = SymbolKind.Property;
  outlineTypeTable[Kind.memberGetAccessor] = SymbolKind.Property;
  outlineTypeTable[Kind.memberSetAccessor] = SymbolKind.Property;
  outlineTypeTable[Kind.variable] = SymbolKind.Variable;
  outlineTypeTable[Kind.const] = SymbolKind.Variable;
  outlineTypeTable[Kind.localVariable] = SymbolKind.Variable;
  outlineTypeTable[Kind.variable] = SymbolKind.Variable;
  outlineTypeTable[Kind.function] = SymbolKind.Function;
  outlineTypeTable[Kind.localFunction] = SymbolKind.Function;
  M = monaco;
}

export class LibFiles {
  private _removedExtraLibs: Record<string, number> = {};

  constructor(
    private _libs: Record<string, string> = {},
    private _extraLibs: Record<string, ExtraLib> = {},
  ) {}

  get libs() {
    return this._libs;
  }

  get extraLibs() {
    return this._extraLibs;
  }

  public setLibs(libs: Record<string, string>) {
    this._libs = libs;
  }

  public setExtraLibs(extraLibs: Record<string, string>) {
    const toRemove = Object.keys(this._extraLibs).filter(
      (key) => !extraLibs[key],
    );
    for (const key of toRemove) {
      this.removeExtraLib(key);
    }
    for (const [filePath, content] of Object.entries(extraLibs)) {
      this.addExtraLib(content, filePath);
    }
  }

  public addExtraLib(content: string, filePath: string): boolean {
    if (
      this._extraLibs[filePath] &&
      this._extraLibs[filePath].content === content
    ) {
      return false;
    }
    let version = 1;
    if (this._removedExtraLibs[filePath]) {
      version = this._removedExtraLibs[filePath] + 1;
    }
    if (this._extraLibs[filePath]) {
      version = this._extraLibs[filePath].version + 1;
    }
    this._extraLibs[filePath] = { content, version };
    return true;
  }

  public removeExtraLib(filePath: string): boolean {
    const lib = this._extraLibs[filePath];
    if (lib) {
      delete this._extraLibs[filePath];
      this._removedExtraLibs[filePath] = lib.version;
      return true;
    }
    return false;
  }

  public isLibFile(uri: Uri | null): boolean {
    if (!uri) {
      return false;
    }
    if (uri.path.indexOf("/lib.") === 0) {
      return uri.path.slice(1) in this._libs;
    }
    return false;
  }

  public getOrCreateModel(fileName: string): editor.ITextModel | null {
    const editor = M.editor;
    const uri = M.Uri.parse(fileName);
    const model = editor.getModel(uri);
    if (model) {
      return model;
    }
    if (this.isLibFile(uri)) {
      return editor.createModel(
        this._libs[uri.path.slice(1)],
        "typescript",
        uri,
      );
    }
    const matchedLibFile = this._extraLibs[fileName];
    if (matchedLibFile) {
      return editor.createModel(matchedLibFile.content, "typescript", uri);
    }
    return null;
  }
}

// global libFiles instance
export const libFiles = new LibFiles();

//#region utils copied from typescript to prevent loading the entire typescriptServices ---

enum IndentStyle {
  None = 0,
  Block = 1,
  Smart = 2,
}

export function flattenDiagnosticMessageText(
  diag: string | ts.DiagnosticMessageChain | undefined,
  newLine: string,
  indent = 0,
): string {
  if (typeof diag === "string") {
    return diag;
  } else if (diag === undefined) {
    return "";
  }
  let result = "";
  if (indent) {
    result += newLine;

    for (let i = 0; i < indent; i++) {
      result += "  ";
    }
  }
  result += diag.messageText;
  indent++;
  if (diag.next) {
    for (const kid of diag.next) {
      result += flattenDiagnosticMessageText(kid, newLine, indent);
    }
  }
  return result;
}

function displayPartsToString(
  displayParts: ts.SymbolDisplayPart[] | undefined,
): string {
  if (displayParts) {
    return displayParts.map((displayPart) => displayPart.text).join("");
  }
  return "";
}

//#endregion

export abstract class Adapter {
  constructor(
    protected _worker: (...uris: Uri[]) => Promise<TypeScriptWorker>,
  ) {}

  // protected _positionToOffset(model: editor.ITextModel, position: monaco.IPosition): number {
  // 	return model.getOffsetAt(position);
  // }

  // protected _offsetToPosition(model: editor.ITextModel, offset: number): monaco.IPosition {
  // 	return model.getPositionAt(offset);
  // }

  protected _textSpanToRange(
    model: editor.ITextModel,
    span: ts.TextSpan,
  ): IRange {
    let p1 = model.getPositionAt(span.start);
    let p2 = model.getPositionAt(span.start + span.length);
    let { lineNumber: startLineNumber, column: startColumn } = p1;
    let { lineNumber: endLineNumber, column: endColumn } = p2;
    return { startLineNumber, startColumn, endLineNumber, endColumn };
  }
}

// --- diagnostics --- ---

export interface DiagnosticsOptions {
  noSemanticValidation?: boolean;
  noSyntaxValidation?: boolean;
  noSuggestionDiagnostics?: boolean;
  /**
   * Limit diagnostic computation to only visible files.
   * Defaults to false.
   */
  onlyVisible?: boolean;
  diagnosticCodesToIgnore?: number[];
}

enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

/**
 * temporary interface until the editor API exposes
 * `IModel.isAttachedToEditor` and `IModel.onDidChangeAttached`
 */
interface IInternalEditorModel extends editor.IModel {
  onDidChangeAttached(listener: () => void): IDisposable;
  isAttachedToEditor(): boolean;
}

export class DiagnosticsAdapter extends Adapter {
  // private _disposables: IDisposable[] = [];
  private _listeners: { [uri: string]: IDisposable } = Object.create(null);

  constructor(
    private _diagnosticsOptions: DiagnosticsOptions,
    onRefreshDiagnostic: IEvent<void>,
    private _selector: string,
    worker: (...uris: Uri[]) => Promise<TypeScriptWorker>,
  ) {
    super(worker);

    const editor = M.editor;
    const onModelAdd = (model: IInternalEditorModel): void => {
      if (model.getLanguageId() !== _selector) {
        return;
      }

      const { onlyVisible } = this._diagnosticsOptions;
      const maybeValidate = () => {
        if (onlyVisible) {
          if (model.isAttachedToEditor()) {
            this._doValidate(model);
          }
        } else {
          this._doValidate(model);
        }
      };

      let timer: number | null = null;
      const disposes = [
        model.onDidChangeContent(() => {
          if (timer !== null) {
            return;
          }
          timer = setTimeout(() => {
            timer = null;
            maybeValidate();
          }, 500);
        }),
      ];

      if (onlyVisible) {
        disposes.push(model.onDidChangeAttached(() => {
          if (model.isAttachedToEditor()) {
            // this model is now attached to an editor
            // => compute diagnostics
            this._doValidate(model);
          } else {
            // this model is no longer attached to an editor
            // => clear existing diagnostics
            editor.setModelMarkers(model, this._selector, []);
          }
        }));
      }

      this._listeners[model.uri.toString()] = {
        dispose() {
          timer = null;
          disposes.forEach((d) => d.dispose());
        },
      };

      maybeValidate();
    };
    const onModelRemoved = (model: editor.IModel): void => {
      const key = model.uri.toString();
      if (this._listeners[key]) {
        this._listeners[key].dispose();
        delete this._listeners[key];
      }
      editor.setModelMarkers(model, this._selector, []);
    };

    editor.onDidCreateModel((model) =>
      onModelAdd(<IInternalEditorModel> model)
    );
    editor.onWillDisposeModel(onModelRemoved);
    editor.onDidChangeModelLanguage((event) => {
      onModelRemoved(event.model);
      onModelAdd(<IInternalEditorModel> event.model);
    });
    onRefreshDiagnostic(() => {
      for (const model of editor.getModels()) {
        onModelRemoved(model);
        onModelAdd(<IInternalEditorModel> model);
      }
    });

    editor.getModels().forEach((model) =>
      onModelAdd(<IInternalEditorModel> model)
    );
  }

  // public dispose(): void {
  //   this._disposables.forEach((d) => d && d.dispose());
  //   this._disposables = [];
  // }

  private async _doValidate(model: editor.ITextModel): Promise<void> {
    const editor = M.editor;
    const worker = await this._worker(model.uri);

    if (model.isDisposed()) {
      // model was disposed in the meantime
      return;
    }

    const promises: Promise<Diagnostic[]>[] = [];
    const {
      noSyntaxValidation,
      noSemanticValidation,
      noSuggestionDiagnostics,
    } = this._diagnosticsOptions;
    if (!noSyntaxValidation) {
      promises.push(worker.getSyntacticDiagnostics(model.uri.toString()));
    }
    if (!noSemanticValidation) {
      promises.push(worker.getSemanticDiagnostics(model.uri.toString()));
    }
    if (!noSuggestionDiagnostics) {
      promises.push(worker.getSuggestionDiagnostics(model.uri.toString()));
    }

    const allDiagnostics = await Promise.all(promises);

    if (!allDiagnostics || model.isDisposed()) {
      // model was disposed in the meantime
      return;
    }

    const diagnostics = allDiagnostics
      .reduce((p, c) => c.concat(p), [])
      .filter(
        (d) =>
          (this._diagnosticsOptions.diagnosticCodesToIgnore || [])
            .indexOf(d.code) ===
            -1,
      );

    if (model.isDisposed()) {
      // model was disposed in the meantime
      return;
    }

    editor.setModelMarkers(
      model,
      this._selector,
      diagnostics.map((d) => DiagnosticsAdapter._convertDiagnostics(model, d)),
    );
  }

  private static _convertDiagnostics(
    model: editor.ITextModel,
    diag: Diagnostic,
  ): editor.IMarkerData {
    const diagStart = diag.start || 0;
    const diagLength = diag.length || 1;
    const { lineNumber: startLineNumber, column: startColumn } = model
      .getPositionAt(diagStart);
    const { lineNumber: endLineNumber, column: endColumn } = model
      .getPositionAt(
        diagStart + diagLength,
      );

    const tags: MarkerTag[] = [];
    if (diag.reportsUnnecessary) {
      tags.push(M.MarkerTag.Unnecessary);
    }
    if (diag.reportsDeprecated) {
      tags.push(M.MarkerTag.Deprecated);
    }

    return {
      severity: DiagnosticsAdapter._tsDiagnosticCategoryToMarkerSeverity(
        diag.category,
      ),
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn,
      message: flattenDiagnosticMessageText(diag.messageText, "\n"),
      code: diag.code.toString(),
      tags,
      relatedInformation: DiagnosticsAdapter._convertRelatedInformation(
        model,
        diag.relatedInformation,
      ),
    };
  }

  private static _convertRelatedInformation(
    model: editor.ITextModel,
    relatedInformation?: DiagnosticRelatedInformation[],
  ): editor.IRelatedInformation[] {
    if (!relatedInformation) {
      return [];
    }

    const result: editor.IRelatedInformation[] = [];
    relatedInformation.forEach((info) => {
      let relatedResource: editor.ITextModel | null = model;
      if (info.file) {
        relatedResource = libFiles.getOrCreateModel(info.file.fileName);
      }

      if (!relatedResource) {
        return;
      }
      const infoStart = info.start || 0;
      const infoLength = info.length || 1;
      const { lineNumber: startLineNumber, column: startColumn } =
        relatedResource.getPositionAt(infoStart);
      const { lineNumber: endLineNumber, column: endColumn } = relatedResource
        .getPositionAt(
          infoStart + infoLength,
        );

      result.push({
        resource: relatedResource.uri,
        startLineNumber,
        startColumn,
        endLineNumber,
        endColumn,
        message: flattenDiagnosticMessageText(info.messageText, "\n"),
      });
    });
    return result;
  }

  private static _tsDiagnosticCategoryToMarkerSeverity(
    category: ts.DiagnosticCategory,
  ): MarkerSeverity {
    const MarkerSeverity = M.MarkerSeverity;
    switch (category) {
      case DiagnosticCategory.Error:
        return MarkerSeverity.Error;
      case DiagnosticCategory.Message:
        return MarkerSeverity.Info;
      case DiagnosticCategory.Warning:
        return MarkerSeverity.Warning;
      case DiagnosticCategory.Suggestion:
        return MarkerSeverity.Hint;
    }
    return MarkerSeverity.Info;
  }
}

// --- suggest ------

interface MyCompletionItem extends languages.CompletionItem {
  label: string;
  uri: Uri;
  position: Position;
  offset: number;
  data?: any;
}

export class SuggestAdapter extends Adapter
  implements languages.CompletionItemProvider {
  public get triggerCharacters(): string[] {
    return ["."];
  }

  public async provideCompletionItems(
    model: editor.ITextModel,
    position: Position,
    _context: languages.CompletionContext,
    token: CancellationToken,
  ): Promise<languages.CompletionList | undefined> {
    const wordInfo = model.getWordUntilPosition(position);
    const wordRange = new M.Range(
      position.lineNumber,
      wordInfo.startColumn,
      position.lineNumber,
      wordInfo.endColumn,
    );
    const resource = model.uri;
    const offset = model.getOffsetAt(position);

    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const info = await worker.getCompletionsAtPosition(
      resource.toString(),
      offset,
    );

    if (!info || model.isDisposed()) {
      return;
    }

    const suggestions: MyCompletionItem[] = info.entries.map((entry) => {
      let range = wordRange;
      if (entry.replacementSpan) {
        const p1 = model.getPositionAt(entry.replacementSpan.start);
        const p2 = model.getPositionAt(
          entry.replacementSpan.start + entry.replacementSpan.length,
        );
        range = new M.Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column);
      }

      const tags: languages.CompletionItemTag[] = [];
      if (
        entry.kindModifiers !== undefined &&
        entry.kindModifiers.indexOf("deprecated") !== -1
      ) {
        tags.push(M.languages.CompletionItemTag.Deprecated);
      }

      return {
        uri: resource,
        position: position,
        offset: offset,
        range: range,
        label: entry.name,
        insertText: entry.name,
        sortText: entry.sortText,
        kind: SuggestAdapter.convertKind(entry.kind),
        data: entry.data,
        tags,
      };
    });

    return {
      suggestions,
    };
  }

  public async resolveCompletionItem(
    item: languages.CompletionItem,
    token: CancellationToken,
  ): Promise<languages.CompletionItem> {
    const myItem = <MyCompletionItem> item;
    const resource = myItem.uri;
    const position = myItem.position;
    const offset = myItem.offset;

    const worker = await this._worker(resource);
    const details = await worker.getCompletionEntryDetails(
      resource.toString(),
      offset,
      myItem.label,
      myItem.data,
    );
    if (!details) {
      return myItem;
    }
    let additionalTextEdits: languages.TextEdit[] = [];
    if (details.codeActions) {
      const model = M.editor.getModel(resource);
      if (model) {
        details.codeActions.forEach((action) =>
          action.changes.forEach((change) =>
            change.textChanges.forEach(({ span, newText }) => {
              additionalTextEdits.push({
                range: this._textSpanToRange(model, span),
                text: newText,
              });
            })
          )
        );
      }
    }
    return <MyCompletionItem> {
      uri: resource,
      position: position,
      label: details.name,
      kind: SuggestAdapter.convertKind(details.kind),
      detail: displayPartsToString(details.displayParts),
      additionalTextEdits,
      documentation: {
        value: SuggestAdapter.createDocumentationString(details),
      },
    };
  }

  private static convertKind(kind: string): languages.CompletionItemKind {
    const languages = M.languages;
    switch (kind) {
      case Kind.primitiveType:
      case Kind.keyword:
        return languages.CompletionItemKind.Keyword;
      case Kind.variable:
      case Kind.localVariable:
        return languages.CompletionItemKind.Variable;
      case Kind.memberVariable:
      case Kind.memberGetAccessor:
      case Kind.memberSetAccessor:
        return languages.CompletionItemKind.Field;
      case Kind.function:
      case Kind.memberFunction:
      case Kind.constructSignature:
      case Kind.callSignature:
      case Kind.indexSignature:
        return languages.CompletionItemKind.Function;
      case Kind.enum:
        return languages.CompletionItemKind.Enum;
      case Kind.module:
        return languages.CompletionItemKind.Module;
      case Kind.class:
        return languages.CompletionItemKind.Class;
      case Kind.interface:
        return languages.CompletionItemKind.Interface;
      case Kind.warning:
        return languages.CompletionItemKind.File;
      case Kind.externalSymbol:
        return languages.CompletionItemKind.Event;
    }

    return languages.CompletionItemKind.Property;
  }

  private static createDocumentationString(
    details: ts.CompletionEntryDetails,
  ): string {
    let documentationString = displayPartsToString(details.documentation);
    if (details.tags) {
      for (const tag of details.tags) {
        documentationString += `\n\n${tagToString(tag)}`;
      }
    }
    return documentationString;
  }
}

function tagToString(tag: ts.JSDocTagInfo): string {
  let tagLabel = `*@${tag.name}*`;
  if (tag.name === "param" && tag.text) {
    const [paramName, ...rest] = tag.text;
    tagLabel += `\`${paramName.text}\``;
    if (rest.length > 0) tagLabel += ` — ${rest.map((r) => r.text).join(" ")}`;
  } else if (Array.isArray(tag.text)) {
    tagLabel += ` — ${tag.text.map((r) => r.text).join("")}`;
  } else if (tag.text) {
    tagLabel += ` — ${tag.text}`;
  }
  return tagLabel;
}

export class SignatureHelpAdapter extends Adapter
  implements languages.SignatureHelpProvider {
  public signatureHelpTriggerCharacters = ["(", ","];

  private static _toSignatureHelpTriggerReason(
    context: languages.SignatureHelpContext,
  ): ts.SignatureHelpTriggerReason {
    const languages = M.languages;
    switch (context.triggerKind) {
      case languages.SignatureHelpTriggerKind.TriggerCharacter:
        if (context.triggerCharacter) {
          if (context.isRetrigger) {
            return {
              kind: "retrigger",
              triggerCharacter: context.triggerCharacter as any,
            };
          } else {
            return {
              kind: "characterTyped",
              triggerCharacter: context.triggerCharacter as any,
            };
          }
        } else {
          return { kind: "invoked" };
        }

      case languages.SignatureHelpTriggerKind.ContentChange:
        return context.isRetrigger
          ? { kind: "retrigger" }
          : { kind: "invoked" };

      case languages.SignatureHelpTriggerKind.Invoke:
      default:
        return { kind: "invoked" };
    }
  }

  public async provideSignatureHelp(
    model: editor.ITextModel,
    position: Position,
    token: CancellationToken,
    context: languages.SignatureHelpContext,
  ): Promise<languages.SignatureHelpResult | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const info = await worker.getSignatureHelpItems(
      resource.toString(),
      offset,
      {
        triggerReason: SignatureHelpAdapter._toSignatureHelpTriggerReason(
          context,
        ),
      },
    );

    if (!info || model.isDisposed()) {
      return;
    }

    const ret: languages.SignatureHelp = {
      activeSignature: info.selectedItemIndex,
      activeParameter: info.argumentIndex,
      signatures: [],
    };

    info.items.forEach((item) => {
      const signature: languages.SignatureInformation = {
        label: "",
        parameters: [],
      };

      signature.documentation = {
        value: displayPartsToString(item.documentation),
      };
      signature.label += displayPartsToString(item.prefixDisplayParts);
      item.parameters.forEach((p, i, a) => {
        const label = displayPartsToString(p.displayParts);
        const parameter: languages.ParameterInformation = {
          label: label,
          documentation: {
            value: displayPartsToString(p.documentation),
          },
        };
        signature.label += label;
        signature.parameters.push(parameter);
        if (i < a.length - 1) {
          signature.label += displayPartsToString(item.separatorDisplayParts);
        }
      });
      signature.label += displayPartsToString(item.suffixDisplayParts);
      ret.signatures.push(signature);
    });

    return {
      value: ret,
      dispose() {},
    };
  }
}

// --- hover ------

export class QuickInfoAdapter extends Adapter
  implements languages.HoverProvider {
  public async provideHover(
    model: editor.ITextModel,
    position: Position,
    token: CancellationToken,
  ): Promise<languages.Hover | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const info = await worker.getQuickInfoAtPosition(
      resource.toString(),
      offset,
    );

    if (!info || model.isDisposed()) {
      return;
    }

    const documentation = displayPartsToString(info.documentation);
    const tags = info.tags
      ? info.tags.map((tag) => tagToString(tag)).join("  \n\n")
      : "";
    const contents = displayPartsToString(info.displayParts);
    return {
      range: this._textSpanToRange(model, info.textSpan),
      contents: [
        {
          value: "```typescript\n" + contents + "\n```\n",
        },
        {
          value: documentation + (tags ? "\n\n" + tags : ""),
        },
      ],
    };
  }
}

// --- occurrences ------

export class DocumentHighlightAdapter extends Adapter
  implements languages.DocumentHighlightProvider {
  public async provideDocumentHighlights(
    model: editor.ITextModel,
    position: Position,
    token: CancellationToken,
  ): Promise<languages.DocumentHighlight[] | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const entries = await worker.getDocumentHighlights(
      resource.toString(),
      offset,
      [
        resource.toString(),
      ],
    );

    if (!entries || model.isDisposed()) {
      return;
    }

    return entries.flatMap((entry) => {
      return entry.highlightSpans.map((highlightSpans) => {
        const languages = M.languages;
        return <languages.DocumentHighlight> {
          range: this._textSpanToRange(model, highlightSpans.textSpan),
          kind: highlightSpans.kind === "writtenReference"
            ? languages.DocumentHighlightKind.Write
            : languages.DocumentHighlightKind.Text,
        };
      });
    });
  }
}

// --- definition ------

export class DefinitionAdapter extends Adapter {
  constructor(
    worker: (...uris: Uri[]) => Promise<TypeScriptWorker>,
  ) {
    super(worker);
  }

  public async provideDefinition(
    model: editor.ITextModel,
    position: Position,
    token: CancellationToken,
  ): Promise<languages.Definition | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const entries = await worker.getDefinitionAtPosition(
      resource.toString(),
      offset,
    );

    if (!entries || model.isDisposed()) {
      return;
    }

    if (model.isDisposed()) {
      return;
    }

    const result: languages.Location[] = [];
    for (let entry of entries) {
      const refModel = libFiles.getOrCreateModel(entry.fileName);
      if (refModel) {
        result.push({
          uri: refModel.uri,
          range: this._textSpanToRange(refModel, entry.textSpan),
        });
      }
    }
    return result;
  }
}

// --- references ------

export class ReferenceAdapter extends Adapter
  implements languages.ReferenceProvider {
  constructor(
    worker: (...uris: Uri[]) => Promise<TypeScriptWorker>,
  ) {
    super(worker);
  }

  public async provideReferences(
    model: editor.ITextModel,
    position: Position,
    context: languages.ReferenceContext,
    token: CancellationToken,
  ): Promise<languages.Location[] | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const entries = await worker.getReferencesAtPosition(
      resource.toString(),
      offset,
    );

    if (!entries || model.isDisposed()) {
      return;
    }

    if (model.isDisposed()) {
      return;
    }

    const result: languages.Location[] = [];
    for (let entry of entries) {
      const refModel = libFiles.getOrCreateModel(entry.fileName);
      if (refModel) {
        result.push({
          uri: refModel.uri,
          range: this._textSpanToRange(refModel, entry.textSpan),
        });
      }
    }
    return result;
  }
}

// --- outline ------

const outlineTypeTable: { [kind: string]: languages.SymbolKind } = {};

export class OutlineAdapter extends Adapter
  implements languages.DocumentSymbolProvider {
  public async provideDocumentSymbols(
    model: editor.ITextModel,
    token: CancellationToken,
  ): Promise<languages.DocumentSymbol[] | undefined> {
    const resource = model.uri;
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const root = await worker.getNavigationTree(resource.toString());

    if (!root || model.isDisposed()) {
      return;
    }

    const convert = (
      item: ts.NavigationTree,
      containerLabel?: string,
    ): languages.DocumentSymbol => {
      const result: languages.DocumentSymbol = {
        name: item.text,
        detail: "",
        kind: <languages.SymbolKind> (outlineTypeTable[item.kind] ||
          M.languages.SymbolKind.Variable),
        range: this._textSpanToRange(model, item.spans[0]),
        selectionRange: this._textSpanToRange(model, item.spans[0]),
        tags: [],
        children: item.childItems?.map((child) => convert(child, item.text)),
        containerName: containerLabel,
      };
      return result;
    };

    // Exclude the root node, as it alwas spans the entire document.
    const result = root.childItems
      ? root.childItems.map((item) => convert(item))
      : [];
    return result;
  }
}

export class Kind {
  public static unknown: string = "";
  public static keyword: string = "keyword";
  public static script: string = "script";
  public static module: string = "module";
  public static class: string = "class";
  public static interface: string = "interface";
  public static type: string = "type";
  public static enum: string = "enum";
  public static variable: string = "var";
  public static localVariable: string = "local var";
  public static function: string = "function";
  public static localFunction: string = "local function";
  public static memberFunction: string = "method";
  public static memberGetAccessor: string = "getter";
  public static memberSetAccessor: string = "setter";
  public static memberVariable: string = "property";
  public static constructorImplementation: string = "constructor";
  public static callSignature: string = "call";
  public static indexSignature: string = "index";
  public static constructSignature: string = "construct";
  public static parameter: string = "parameter";
  public static typeParameter: string = "type parameter";
  public static primitiveType: string = "primitive type";
  public static label: string = "label";
  public static alias: string = "alias";
  public static const: string = "const";
  public static let: string = "let";
  public static warning: string = "warning";
  public static externalSymbol = "external symbol";
}

// --- formatting ----

export abstract class FormatHelper extends Adapter {
  protected static _convertOptions(
    options: languages.FormattingOptions,
  ): ts.FormatCodeSettings {
    return {
      convertTabsToSpaces: options.insertSpaces,
      tabSize: options.tabSize,
      indentSize: options.tabSize,
      indentStyle: IndentStyle.Smart,
      newLineCharacter: "\n",
      insertSpaceAfterCommaDelimiter: true,
      insertSpaceAfterSemicolonInForStatements: true,
      insertSpaceBeforeAndAfterBinaryOperators: true,
      insertSpaceAfterKeywordsInControlFlowStatements: true,
      insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
      insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
      insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
      insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
      placeOpenBraceOnNewLineForControlBlocks: false,
      placeOpenBraceOnNewLineForFunctions: false,
    };
  }

  protected _convertTextChanges(
    model: editor.ITextModel,
    change: ts.TextChange,
  ): languages.TextEdit {
    return {
      text: change.newText,
      range: this._textSpanToRange(model, change.span),
    };
  }
}

export class FormatAdapter extends FormatHelper
  implements languages.DocumentRangeFormattingEditProvider {
  readonly canFormatMultipleRanges = false;

  public async provideDocumentRangeFormattingEdits(
    model: editor.ITextModel,
    range: Range,
    options: languages.FormattingOptions,
    token: CancellationToken,
  ): Promise<languages.TextEdit[] | undefined> {
    const resource = model.uri;
    const startOffset = model.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
    const endOffset = model.getOffsetAt({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    });
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const edits = await worker.getFormattingEditsForRange(
      resource.toString(),
      startOffset,
      endOffset,
      FormatHelper._convertOptions(options),
    );

    if (!edits || model.isDisposed()) {
      return;
    }

    return edits.map((edit) => this._convertTextChanges(model, edit));
  }
}

export class FormatOnTypeAdapter extends FormatHelper
  implements languages.OnTypeFormattingEditProvider {
  get autoFormatTriggerCharacters() {
    return [";", "}", "\n"];
  }

  public async provideOnTypeFormattingEdits(
    model: editor.ITextModel,
    position: Position,
    ch: string,
    options: languages.FormattingOptions,
    token: CancellationToken,
  ): Promise<languages.TextEdit[] | undefined> {
    const resource = model.uri;
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const edits = await worker.getFormattingEditsAfterKeystroke(
      resource.toString(),
      offset,
      ch,
      FormatHelper._convertOptions(options),
    );

    if (!edits || model.isDisposed()) {
      return;
    }

    return edits.map((edit) => this._convertTextChanges(model, edit));
  }
}

// --- code actions ------

export class CodeActionAdaptor extends FormatHelper
  implements languages.CodeActionProvider {
  public async provideCodeActions(
    model: editor.ITextModel,
    range: Range,
    context: languages.CodeActionContext,
    token: CancellationToken,
  ): Promise<languages.CodeActionList | undefined> {
    const resource = model.uri;
    const start = model.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
    const end = model.getOffsetAt({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    });
    const formatOptions = FormatHelper._convertOptions(model.getOptions());
    const errorCodes = context.markers
      .filter((m) => m.code)
      .map((m) => m.code)
      .map(Number);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const codeFixes = await worker.getCodeFixesAtPosition(
      resource.toString(),
      start,
      end,
      errorCodes,
      formatOptions,
    );

    if (!codeFixes || model.isDisposed()) {
      return { actions: [], dispose: () => {} };
    }

    const actions = codeFixes
      .filter((fix) => {
        // Removes any 'make a new file'-type code fix
        return fix.changes.filter((change) => change.isNewFile).length === 0;
      })
      .map((fix) => {
        return this._tsCodeFixActionToMonacoCodeAction(model, context, fix);
      });

    return {
      actions: actions,
      dispose: () => {},
    };
  }

  private _tsCodeFixActionToMonacoCodeAction(
    model: editor.ITextModel,
    context: languages.CodeActionContext,
    codeFix: ts.CodeFixAction,
  ): languages.CodeAction {
    const edits: languages.IWorkspaceTextEdit[] = [];
    for (const change of codeFix.changes) {
      for (const textChange of change.textChanges) {
        edits.push({
          resource: model.uri,
          versionId: undefined,
          textEdit: {
            range: this._textSpanToRange(model, textChange.span),
            text: textChange.newText,
          },
        });
      }
    }

    const action: languages.CodeAction = {
      title: codeFix.description,
      edit: { edits: edits },
      diagnostics: context.markers,
      kind: "quickfix",
    };

    return action;
  }
}

// --- rename ----

export class RenameAdapter extends Adapter implements languages.RenameProvider {
  constructor(
    worker: (...uris: Uri[]) => Promise<TypeScriptWorker>,
  ) {
    super(worker);
  }
  public async provideRenameEdits(
    model: editor.ITextModel,
    position: Position,
    newName: string,
    token: CancellationToken,
  ): Promise<(languages.WorkspaceEdit & languages.Rejection) | undefined> {
    const resource = model.uri;
    const fileName = resource.toString();
    const offset = model.getOffsetAt(position);
    const worker = await this._worker(resource);

    if (model.isDisposed()) {
      return;
    }

    const renameInfo = await worker.getRenameInfo(fileName, offset, {
      allowRenameOfImportPath: false,
    });
    if (renameInfo.canRename === false) {
      // use explicit comparison so that the discriminated union gets resolved properly
      return {
        edits: [],
        rejectReason: renameInfo.localizedErrorMessage,
      };
    }
    if (renameInfo.fileToRename !== undefined) {
      throw new Error("Renaming files is not supported.");
    }

    const renameLocations = await worker.findRenameLocations(
      fileName,
      offset,
      /*strings*/ false,
      /*comments*/ false,
      /*prefixAndSuffix*/ false,
    );

    if (!renameLocations || model.isDisposed()) {
      return;
    }

    const edits: languages.IWorkspaceTextEdit[] = [];
    for (const renameLocation of renameLocations) {
      const model = libFiles.getOrCreateModel(renameLocation.fileName);
      if (model) {
        edits.push({
          resource: model.uri,
          versionId: undefined,
          textEdit: {
            range: this._textSpanToRange(model, renameLocation.textSpan),
            text: newName,
          },
        });
      } else {
        throw new Error(`Unknown file ${renameLocation.fileName}.`);
      }
    }

    return { edits };
  }
}

// --- inlay hints ----

export class InlayHintsAdapter extends Adapter
  implements languages.InlayHintsProvider {
  public async provideInlayHints(
    model: editor.ITextModel,
    range: Range,
    token: CancellationToken,
  ): Promise<languages.InlayHintList | null> {
    const resource = model.uri;
    const fileName = resource.toString();
    const start = model.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
    const end = model.getOffsetAt({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    });
    const worker = await this._worker(resource);
    if (model.isDisposed()) {
      return null;
    }

    const tsHints = await worker.provideInlayHints(fileName, start, end);
    const hints: languages.InlayHint[] = tsHints.map((hint) => {
      return {
        ...hint,
        label: hint.text,
        position: model.getPositionAt(hint.position),
        kind: this._convertHintKind(hint.kind),
      };
    });
    return { hints, dispose: () => {} };
  }

  private _convertHintKind(kind?: ts.InlayHintKind) {
    const languages = M.languages;
    switch (kind) {
      case "Parameter":
        return languages.InlayHintKind.Parameter;
      case "Type":
        return languages.InlayHintKind.Type;
      default:
        return languages.InlayHintKind.Type;
    }
  }
}
