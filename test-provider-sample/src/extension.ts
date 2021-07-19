import * as vscode from 'vscode';
import { getContentFromFilesystem, MarkdownTestData, TestCase, testData, TestFile } from './testTree';

export async function activate(context: vscode.ExtensionContext) {
  const ctrl = vscode.test.createTestController('mathTestController', 'Markdown Math');
  context.subscriptions.push(ctrl);

  const runHandler: vscode.TestRunHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
    const queue: { test: vscode.TestItem; data: TestCase }[] = [];
    const run = ctrl.createTestRun(request);
    // map of file uris to statments on each line:
    const coveredLines = new Map</* file uri */ string, (vscode.StatementCoverage | undefined)[]>();

    const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }

        const data = testData.get(test);
        if (data instanceof TestCase) {
          run.setState(test, vscode.TestResultState.Queued);
          queue.push({ test, data });
        } else {
          if (data instanceof TestFile && !data.didResolve) {
            await data.updateFromDisk(test);
          }

          await discoverTests(test.children);
        }

        if (test.uri && !coveredLines.has(test.uri.toString())) {
          try {
            const lines = (await getContentFromFilesystem(test.uri)).split('\n');
            coveredLines.set(
              test.uri.toString(),
              lines.map((lineText, lineNo) =>
                lineText.trim().length ? new vscode.StatementCoverage(0, new vscode.Position(lineNo, 0)) : undefined
              )
            );
          } catch {
            // ignored
          }
        }
      }
    };

    const runTestQueue = async () => {
      for (const { test, data } of queue) {
        run.appendOutput(`Running ${test.id}\r\n`);
        if (cancellation.isCancellationRequested) {
          run.setState(test, vscode.TestResultState.Skipped);
        } else {
          run.setState(test, vscode.TestResultState.Running);
          await data.run(test, run);
        }

        const lineNo = test.range!.start.line;
        const fileCoverage = coveredLines.get(test.uri!.toString());
        if (fileCoverage) {
          fileCoverage[lineNo]!.executionCount++;
        }

        run.appendOutput(`Completed ${test.id}\r\n`);
      }

      run.end();
    };

    run.coverageProvider = {
      provideFileCoverage() {
        const coverage: vscode.FileCoverage[] = [];
        for (const [uri, statements] of coveredLines) {
          coverage.push(
            vscode.FileCoverage.fromDetails(
              vscode.Uri.parse(uri),
              statements.filter((s): s is vscode.StatementCoverage => !!s)
            )
          );
        }

        return coverage;
      },
    };

    discoverTests(request.include ?? ctrl.items).then(runTestQueue);
  };
  
  ctrl.createRunProfile('Run Tests', vscode.TestRunProfileGroup.Run, runHandler, true);

  ctrl.resolveChildrenHandler = async item => {
    const data = testData.get(item);
    if (data instanceof TestFile) {
      await data.updateFromDisk(item);
    }
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    if (e.uri.scheme !== 'file') {
      return;
    }
    
    if (!e.uri.path.endsWith('.md')) {
      return;
    }

    const { file, data } = getOrCreateFile(ctrl, e.uri);
    data.updateFromContents(e.getText(), file);
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument(e => updateNodeForDocument(e.document)),
    ...(await startWatchingWorkspace(ctrl))
  );
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
  const existing = controller.items.get(uri.toString());
  if (existing) {
    return { file: existing, data: testData.get(existing) as TestFile };
  }

  const file = vscode.test.createTestItem(uri.toString(), uri.path.split('/').pop()!, uri);
  controller.items.add(file);

  const data = new TestFile();
  testData.set(file, data);

  file.canResolveChildren = true;
  return { file, data };
}

function startWatchingWorkspace(controller: vscode.TestController) {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  return Promise.all(
    vscode.workspace.workspaceFolders.map(async workspaceFolder => {
      const pattern = new vscode.RelativePattern(workspaceFolder, '**/*.md');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidCreate(uri => getOrCreateFile(controller, uri));
      watcher.onDidChange(uri => {
        const { file, data } = getOrCreateFile(controller, uri);
        if (data.didResolve) {
          data.updateFromDisk(file);
        }
      });
      watcher.onDidDelete(uri => controller.items.delete(uri.toString()));

      const files = await vscode.workspace.findFiles(pattern);
      for (const file of files) {
        getOrCreateFile(controller, file);
      }

      return watcher;
    })
  );
}
