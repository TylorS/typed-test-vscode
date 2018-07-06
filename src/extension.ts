'use strict'
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode'
import { sync as resolve } from 'resolve'
import {
  TestMetadata,
  resultsToString,
  statsToString,
  getTestStats,
  getTestResults,
  JsonResults,
  TestStats,
  Logger,
  TestResult,
  NodeMetadata
} from '@typed/test'
import { strip } from 'typed-colors'
import { join } from 'path'
import { sync } from 'glob'
import { all } from 'clear-require'

const pipe = <A, B, C>(f: (a: A) => B, g: (b: B) => C) => (value: A): C => g(f(value))

const EXCLUDE = ['./node_modules/**']

const logger: Logger = {
  log: (x: string) => {
    console.log(x)
    vscode.window.showInformationMessage(`Typed Test: ${x}`)

    return Promise.resolve()
  },
  error: (x: string) => {
    console.error(x)
    vscode.window.showErrorMessage(x)

    return Promise.resolve()
  },
  clear: () => Promise.resolve(console.clear())
}

const dispose = (d: vscode.Disposable) => d.dispose()

function findTypedTest(cwd: string) {
  try {
    // Users must have @typed/test installed locally.
    return resolve('@typed/test', { basedir: cwd })
  } catch {
    // For developing @typed/test extension
    return join(cwd, 'lib/index.js')
  }
}

export function activate(context: vscode.ExtensionContext) {
  const cwd = vscode.workspace.rootPath
  const typedTestApiPath = findTypedTest(cwd).replace('index.js', 'api.js')
  let config = setup(cwd, typedTestApiPath)
  let firstRun = true
  logger.log('Typed Test: Activated!')

  const runTestsDisposable = vscode.commands.registerCommand('TypedTest.runTests', async () => {
    if (!firstRun) {
      config.dispose()
      config = setup(cwd, typedTestApiPath)
    }

    firstRun = false

    const {
      fileGlobs,
      compilerOptions,
      handleMetadata,
      options: { mode }
    } = config
    const sourcePaths = flatten(fileGlobs.map(x => sync(x, { cwd })))
    const metadata = await config.findTestMetadata(cwd, sourcePaths, compilerOptions, mode)

    await handleMetadata(metadata)
  })

  const watchTestsDisposable = vscode.commands.registerCommand('TypedTest.watchTests', async () => {
    if (!firstRun) {
      config.dispose()
      config = setup(cwd, typedTestApiPath, config.results)
    }

    firstRun = false

    const {
      fileGlobs,
      compilerOptions,
      handleMetadata,
      options: { mode },
      results: { removeFilePath },
      addWatcherDisposable
    } = config
    
    await logger.log('Starting file watcher...')
    const watcher = await config.watchTestMetadata(
      cwd,
      fileGlobs,
      compilerOptions,
      mode,
      logger,
      removeFilePath,
      handleMetadata
    )

    const watcherDisposable: vscode.Disposable = { dispose: () => watcher.close() }
    addWatcherDisposable(watcherDisposable)
  })

  const stopWatchingDisposable = vscode.commands.registerCommand('TypedTest.stopWatching', () => {
    config.dispose()
    logger.log(`Watcher Stopped.`)
  })

  context.subscriptions.push(runTestsDisposable, watchTestsDisposable, stopWatchingDisposable, {
    dispose: () => config.dispose()
  })
}

function setup(
  cwd: string,
  typedTestApiPath: string,
  previousResults: import('@typed/test/lib/api').Results | null = null
) {
  all()
  const {
    watchTestMetadata,
    findTestMetadata,
    TestRunner,
    findTsConfig,
    findTypedTestConfig
  }: typeof import('@typed/test/lib/api') = require(typedTestApiPath)
  const { compilerOptions, files = [], include = [], exclude = EXCLUDE } = findTsConfig(cwd)
  const fileGlobs = [...files, ...include, ...exclude.map(x => `!${x}`)]
  const typedTestConfig = findTypedTestConfig(compilerOptions, cwd)
  const { options, results, runTests } = new TestRunner(
    typedTestConfig,
    previousResults,
    cwd,
    logger
  )
  const { getResults, updateResults } = results
  const displayResults = setDecorationResults(getResults)
  const watcherDisposables: Array<vscode.Disposable> = []
  const disposables: Array<vscode.Disposable> = []
  const addDisposables = (d: Array<vscode.Disposable>) => disposables.push(...d)
  const displayAndAdd = pipe(
    displayResults,
    addDisposables
  )
  const updateStats = pipe(
    pipe(
      updateResults,
      getTestResults
    ),
    getTestStats
  )
  const contextDisposables = [
    vscode.window.onDidChangeActiveTextEditor(editor => editor && displayAndAdd(editor)),
    vscode.window.onDidChangeVisibleTextEditors(editors =>
      editors.forEach(editor => editor && displayAndAdd(editor))
    )
  ]

  const handleMetadata = async (metadata: TestMetadata[]) => {
    const codeConsole = vscode.debug.activeDebugConsole
    const [{ results }, processResults] = await runTests(metadata)
    const stats = updateStats(results)

    await logger.log(strip(statsToString(stats)))

    if (options.typeCheck) {
      codeConsole.append(processResults.stdout)
    }

    if (options.typeCheck && processResults.exitCode > 0) {
      codeConsole.append(processResults.stderr)
    }

    codeConsole.appendLine('')
    codeConsole.appendLine(`Typed Test ${new Date().toLocaleString()}`)
    codeConsole.append(resultsToString(results))

    disposables.forEach(dispose)
    vscode.window.visibleTextEditors.forEach(editor => editor && displayAndAdd(editor))
  }

  return {
    logger,
    results,
    runTests,
    options,
    handleMetadata,
    fileGlobs,
    compilerOptions,
    dispose: () => {
      disposables.forEach(dispose)
      contextDisposables.forEach(dispose)
      watcherDisposables.forEach(dispose)
    },
    addWatcherDisposable: (disposable: vscode.Disposable) => watcherDisposables.push(disposable),
    watchTestMetadata,
    findTestMetadata
  }
}

// this method is called when your extension is deactivated
export function deactivate() {
  console.log('deactivated')
}

function setDecorationResults(getResults: () => JsonResults[]) {
  return (editor: vscode.TextEditor): vscode.Disposable[] => {
    const fileName = editor.document.fileName
    const exportedResults = getResults()
    const usableResults = exportedResults.filter(x => x.filePath === fileName)

    return flatten(usableResults.map(getTestMarkers(editor)))
  }
}

type MarkerMetadata = {
  line: number
  results: Array<TestResult>
  additionalTests: Array<NodeMetadata>
}

function getTestMarkers(editor: vscode.TextEditor) {
  const setTestMarker = <A extends MarkerMetadata>(jsonResult: A): Array<vscode.Disposable> => {
    if (jsonResult.additionalTests.length > 0) {
      const zippedResults = zip(
        jsonResult.additionalTests,
        flatten(
          jsonResult.results.map(result => (result.type === 'group' ? result.results : [result]))
        )
      )

      return [
        setMarker({
          main: true,
          line: jsonResult.line,
          editor,
          stats: getTestStats(jsonResult.results)
        }),
        ...flatten(
          zippedResults.map(([metadata, result]) =>
            setTestMarker({
              line: metadata.line,
              additionalTests: metadata.additionalTests,
              results: [result],
              main: false
            })
          )
        )
      ]
    }

    return [
      setMarker({
        main: false,
        line: jsonResult.line,
        editor,
        stats: getTestStats(jsonResult.results)
      })
    ]
  }

  return setTestMarker
}

function zip<A, B>(xs: Array<A>, ys: Array<B>): ReadonlyArray<[A, B]> {
  const length = Math.min(xs.length, ys.length)
  const newList = Array(length)

  for (let i = 0; i < length; ++i) newList[i] = [xs[i], ys[i]]

  return newList
}

type MarkerSpec = {
  line: number
  stats: TestStats
  editor: vscode.TextEditor
  main: boolean
}

function setMarker({ editor, stats, line, main }: MarkerSpec): vscode.Disposable {
  const lineIndex = line - 1
  const passingIcon = join(__dirname, '../images/passing-test.png')
  const failingIcon = join(__dirname, '../images/failing-test.png')
  const skippedIcon = join(__dirname, '../images/skipped-test.png')
  const passingOrSkipped = main
    ? stats.passing > 0
      ? passingIcon
      : skippedIcon
    : stats.skipped > 0
      ? skippedIcon
      : passingIcon
  const marker = vscode.window.createTextEditorDecorationType({
    gutterIconPath: stats.failing > 0 ? failingIcon : passingOrSkipped,
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
