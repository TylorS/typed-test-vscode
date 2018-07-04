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
  getTestResults,
  JsonResults,
  TestStats
} from '@typed/test'
import { strip } from 'typed-colors'
import { join } from 'path'

const pipe = <A, B, C>(f: (a: A) => B, g: (b: B) => C) => (value: A): C => g(f(value))

export function activate(context: vscode.ExtensionContext) {
  const cwd = vscode.workspace.rootPath
  const {
    fileGlobs,
    compilerOptions,
    options: { mode },
    results: { removeFilePath, updateResults, getResults },
    runTests
  } = new TestRunner(cwd, {})
  const displayResults = setDecorationResults(cwd, getResults)
  const disposables: Array<vscode.Disposable> = []
  const addDisposables = (d: Array<vscode.Disposable>) => disposables.push(...d)
  const dispose = () => disposables.forEach(d => d.dispose())
  const displayAndAdd = pipe(displayResults, addDisposables)
  const update = pipe(updateResults, getTestResults)
  const updateStats = pipe(update, getTestStats)

  const watchTestsDisposable = vscode.commands.registerCommand('extension.watchTests', async () => {
    console.log('Starting file watcher...')
    const watcher = await watchTestMetadata(
      cwd,
      fileGlobs,
      compilerOptions,
      mode,
      removeFilePath,
      async (metadata: TestMetadata[]) => {
        const codeConsole = vscode.debug.activeDebugConsole
        const [{ results }] = await runTests(metadata)
        const stats = updateStats(results)

        vscode.window.showInformationMessage(`Typed Test: ${strip(statsToString(stats))}`)
        codeConsole.appendLine('')
        codeConsole.appendLine(`Typed Test ${new Date().toLocaleString()}`)
        codeConsole.append(resultsToString(cwd, results))

        dispose()
        vscode.window.visibleTextEditors.forEach(displayAndAdd)
      }
    )

    context.subscriptions.push({ dispose: () => watcher.close() })
  })

  context.subscriptions.push(
    watchTestsDisposable,
    vscode.window.onDidChangeActiveTextEditor(displayAndAdd),
    vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(displayAndAdd))
  )
}

// this method is called when your extension is deactivated
export function deactivate() {
  console.log('deactivated')
}

function setDecorationResults(cwd: string, getResults: () => JsonResults[]) {
  return (editor: vscode.TextEditor): vscode.Disposable[] => {
    const fileName = editor.document.fileName
    const exportedResults = getResults().filter(x => x.exportNames.length > 0)
    const usableResults = exportedResults.filter(x => join(cwd, x.filePath) === fileName)

    return usableResults.map(({ line, results }) =>
      setMarker({ line, stats: getTestStats(results), editor })
    )
  }
}

type MarkerSpec = {
  line: number
  stats: TestStats
  editor: vscode.TextEditor
}

function setMarker({ editor, stats, line }: MarkerSpec): vscode.Disposable {
  const lineIndex = line - 1
  const passingIcon = join(__dirname, '../src/passing-test.png')
  const failingIcon = join(__dirname, '../src/failing-test.png')
  const passing = stats.failing === 0

  const marker = vscode.window.createTextEditorDecorationType({
    gutterIconPath: passing ? passingIcon : failingIcon,
    gutterIconSize: '16px'
  })

  editor.setDecorations(marker, [
    new vscode.Range(new vscode.Position(lineIndex, 0), new vscode.Position(lineIndex, 1))
  ])

  return marker
}

function flatten<A>(list: Array<Array<A>>): Array<A> {
  return list.reduce((xs, x) => xs.concat(x), [] as Array<A>)
}
