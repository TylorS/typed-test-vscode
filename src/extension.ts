'use strict'
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import {
  watchTestMetadata,
  TestRunner,
  TestMetadata,
  resultsToString,
  statsToString,
  getTestStats,
  getTestResults
} from '@typed/test'
import { strip } from 'typed-colors'

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const cwd = vscode.workspace.rootPath
  const {
    fileGlobs,
    compilerOptions,
    options: { mode },
    results: { removeFilePath, updateResults },
    runTests
  } = new TestRunner(cwd, {})

  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated

  const disposable = vscode.commands.registerCommand('extension.watchTests', async () => {
    console.log('Starting file watcher...')

    const watcher = await watchTestMetadata(
      cwd,
      fileGlobs,
      compilerOptions,
      mode,
      removeFilePath,
      async (metadata: TestMetadata[]) => {
        const [{ results }] = await runTests(metadata)
        const updatedResults = updateResults(results)
        const stats = getTestStats(getTestResults(updatedResults))

        vscode.window.showInformationMessage(`Typed Test: ${strip(statsToString(stats))}`)

        const console = vscode.debug.activeDebugConsole

        console.appendLine('')
        console.appendLine(`Typed Test ${new Date().toLocaleString()}`)
        console.append(resultsToString(results))
      }
    )

    context.subscriptions.push({ dispose: () => watcher.close() })
  })

  context.subscriptions.push(disposable)
}

// this method is called when your extension is deactivated
export function deactivate() {
  console.log('deactivated')
}
