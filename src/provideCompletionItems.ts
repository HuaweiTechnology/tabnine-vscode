import * as vscode from "vscode";
import {
  autocomplete,
  AutocompleteResult,
  MarkdownStringSpec,
  ResultEntry,
} from "./binary/requests/requests";
import { Capability, isCapabilityEnabled } from "./capabilities";
import { CHAR_LIMIT, DEFAULT_DETAIL, MAX_NUM_RESULTS } from "./consts";
import { tabnineContext } from "./extensionContext";
import { COMPLETION_IMPORTS } from "./selectionHandler";

export default async function provideCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
  context: vscode.CompletionContext
): Promise<vscode.CompletionList | undefined> {
  try {
    if (!completionIsAllowed(document, position)) {
      return;
    }

    const offset = document.offsetAt(position);
    const before_start_offset = Math.max(0, offset - CHAR_LIMIT);
    const after_end_offset = offset + CHAR_LIMIT;
    const before_start = document.positionAt(before_start_offset);
    const after_end = document.positionAt(after_end_offset);
    const response: AutocompleteResult | null | undefined = await autocomplete({
      filename: document.fileName,
      before: document.getText(new vscode.Range(before_start, position)),
      after: document.getText(new vscode.Range(position, after_end)),
      region_includes_beginning: before_start_offset === 0,
      region_includes_end: document.offsetAt(after_end) !== after_end_offset,
      max_num_results: getMaxResults(),
    });

    if (!response) {
      return;
    }

    let completionList = [];
    if (response?.results.length !== 0) {
      let detailMessage = "";

      for (const msg of response.user_message ?? []) {
        if (detailMessage !== "") {
          detailMessage += "\n";
        }
        detailMessage += msg;
      }
      if (detailMessage === "") {
        detailMessage = DEFAULT_DETAIL;
      }

      let limit = undefined;
      if (showFew(response, document, position)) {
        limit = 1;
      }
      let index = 0;
      for (const entry of response?.results) {
        completionList.push(
          makeCompletionItem({
            document,
            index,
            position,
            detailMessage,
            old_prefix: response?.old_prefix,
            entry,
            results: response?.results,
          })
        );
        index += 1;
        if (limit !== undefined && index >= limit) {
          break;
        }
      }
    }

    return new vscode.CompletionList(completionList, true);
  } catch (e) {
    console.error(`Error setting up request: ${e}`);
  }
  return;
}

export type CompletionArguments = {
  currentCompletion: string;
  completions: ResultEntry[];
  position: vscode.Position;
};

function makeCompletionItem(args: {
  document: vscode.TextDocument;
  index: number;
  position: vscode.Position;
  detailMessage: string;
  old_prefix: string;
  entry: ResultEntry;
  results: ResultEntry[];
}): vscode.CompletionItem {
  let item = new vscode.CompletionItem(
    (isCapabilityEnabled(Capability.ON_BOARDING_CAPABILITY) ? "✨ " : "") +
      args.entry.new_prefix
  );

  item.sortText = String.fromCharCode(0) + String.fromCharCode(args.index);
  item.insertText = new vscode.SnippetString(
    escapeTabStopSign(args.entry.new_prefix)
  );
  item.filterText = args.entry.new_prefix;
  item.preselect = args.index === 0;
  item.kind = args.entry.kind;
  item.range = new vscode.Range(
    args.position.translate(0, -args.old_prefix.length),
    args.position.translate(0, args.entry.old_suffix.length)
  );

  if (tabnineContext.isTabNineAutoImportEnabled) {
    item.command = {
      arguments: [
        {
          currentCompletion: args.entry.new_prefix,
          completions: args.results,
          position: args.position,
        },
      ],
      command: COMPLETION_IMPORTS,
      title: "accept completion",
    };
  }

  if (args.entry.new_suffix) {
    item.insertText
      .appendTabstop(0)
      .appendText(escapeTabStopSign(args.entry.new_suffix));
  }

  if (args.entry.documentation) {
    item.documentation = formatDocumentation(args.entry.documentation);
  }

  if (
    args.entry.detail &&
    (args.detailMessage === DEFAULT_DETAIL ||
      args.detailMessage.includes("Your project contains"))
  ) {
    item.detail = args.entry.detail;
  } else {
    item.detail = args.detailMessage;
  }

  return item;
}

function getMaxResults(): number {
  if (isCapabilityEnabled(Capability.SUGGESTIONS_SINGLE)) {
    return 1;
  }

  if (isCapabilityEnabled(Capability.SUGGESTIONS_TWO)) {
    return 2;
  }

  return MAX_NUM_RESULTS;
}

function formatDocumentation(
  documentation: string | MarkdownStringSpec
): string | vscode.MarkdownString {
  if (isMarkdownStringSpec(documentation)) {
    if (documentation.kind == "markdown") {
      return new vscode.MarkdownString(documentation.value);
    } else {
      return documentation.value;
    }
  } else {
    return documentation;
  }
}

function escapeTabStopSign(value: string) {
  return value.replace(new RegExp("\\$", "g"), "\\$");
}

function isMarkdownStringSpec(x: any): x is MarkdownStringSpec {
  return x.kind;
}

function completionIsAllowed(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const configuration = vscode.workspace.getConfiguration();
  let disable_line_regex = configuration.get<string[]>(
    "tabnine.disable_line_regex"
  );
  if (disable_line_regex === undefined) {
    disable_line_regex = [];
  }
  let line = undefined;
  for (const r of disable_line_regex) {
    if (line === undefined) {
      line = document.getText(
        new vscode.Range(
          position.with({ character: 0 }),
          position.with({ character: 500 })
        )
      );
    }
    if (new RegExp(r).test(line)) {
      return false;
    }
  }
  let disable_file_regex = configuration.get<string[]>(
    "tabnine.disable_file_regex"
  );
  if (disable_file_regex === undefined) {
    disable_file_regex = [];
  }
  for (const r of disable_file_regex) {
    if (new RegExp(r).test(document.fileName)) {
      return false;
    }
  }
  return true;
}

function showFew(
  response: AutocompleteResult,
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  for (const entry of response.results) {
    if (entry.kind || entry.documentation) {
      return false;
    }
  }
  const leftPoint = position.translate(0, -response.old_prefix.length);
  const tail = document.getText(
    new vscode.Range(document.lineAt(leftPoint).range.start, leftPoint)
  );
  return tail.endsWith(".") || tail.endsWith("::");
}