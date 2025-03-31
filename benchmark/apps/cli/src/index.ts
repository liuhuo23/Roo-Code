import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import pMap from "p-map"
import pWaitFor from "p-wait-for"
import { execa, parseCommandString } from "execa"
import { build, filesystem, GluegunPrompt, GluegunToolbox } from "gluegun"

import {
	type ExerciseLanguage,
	exerciseLanguages,
	RooCodeEventName,
	IpcOrigin,
	IpcMessageType,
	TaskCommandName,
	rooCodeDefaults,
} from "@benchmark/types"
import {
	type Run,
	findRun,
	createRun,
	finishRun,
	type Task,
	createTask,
	getTasks,
	updateTask,
	createTaskMetrics,
	updateTaskMetrics,
} from "@benchmark/db"
import { inChunksOf } from "@benchmark/lib"
import { IpcServer, IpcClient } from "@benchmark/ipc"

import { __dirname, extensionDevelopmentPath, exercisesPath } from "./paths.js"
import { getExercises } from "./exercises.js"

const testCommands: Record<ExerciseLanguage, { commands: string[]; timeout?: number; cwd?: string }> = {
	cpp: { commands: ["cmake -G 'Unix\\ Makefiles' -DEXERCISM_RUN_ALL_TESTS=1 ..", "make"], cwd: "build" }, // timeout 15s bash -c "cd '$dir' && mkdir -p build && cd build && cmake -G 'Unix Makefiles' -DEXERCISM_RUN_ALL_TESTS=1 .. >/dev/null 2>&1 && make >/dev/null 2>&1"
	go: { commands: ["go test"] }, // timeout 15s bash -c "cd '$dir' && go test > /dev/null 2>&1"
	java: { commands: ["./gradlew test"] }, // timeout --foreground 15s bash -c "cd '$dir' && ./gradlew test > /dev/null 2>&1"
	javascript: { commands: ["pnpm install", "pnpm test"], timeout: 30_000 }, // timeout 30s bash -c "cd '$dir' && pnpm install >/dev/null 2>&1 && pnpm test >/dev/null 2>&1"
	python: { commands: ["uv run python3 -m pytest -o markers=task *_test.py"] }, // timeout 15s bash -c "cd '$dir' && uv run python3 -m pytest -o markers=task *_test.py"
	rust: { commands: ["cargo test"] }, // timeout 15s bash -c "cd '$dir' && cargo test > /dev/null 2>&1"
}

const run = async (toolbox: GluegunToolbox) => {
	const { config, prompt } = toolbox

	let { language, exercise } = config

	if (![undefined, ...exerciseLanguages, "all"].includes(language)) {
		throw new Error(`Language is invalid: ${language}`)
	}

	if (!["undefined", "string"].includes(typeof exercise)) {
		throw new Error(`Exercise is invalid: ${exercise}`)
	}

	const id = config.runId ? Number(config.runId) : undefined
	let run: Run

	if (id) {
		run = await findRun(id)
	} else {
		run = await createRun({
			model: rooCodeDefaults.openRouterModelId!,
			pid: process.pid,
			socketPath: path.resolve(os.tmpdir(), `benchmark-${crypto.randomUUID()}.sock`),
		})

		if (language === "all") {
			for (const language of exerciseLanguages) {
				const exercises = getExercises()[language as ExerciseLanguage]

				await pMap(exercises, (exercise) => createTask({ runId: run.id, language, exercise }), {
					concurrency: 10,
				})
			}
		} else if (exercise === "all") {
			const exercises = getExercises()[language as ExerciseLanguage]
			await pMap(exercises, (exercise) => createTask({ runId: run.id, language, exercise }), { concurrency: 10 })
		} else {
			language = language || (await askLanguage(prompt))
			exercise = exercise || (await askExercise(prompt, language))
			await createTask({ runId: run.id, language, exercise })
		}
	}

	const tasks = await getTasks(run.id)

	if (!tasks[0]) {
		throw new Error("No tasks found.")
	}

	const server = new IpcServer(run.socketPath, () => {})
	server.listen()

	// server.on(IpcMessageType.Connect, (clientId) => {
	// 	server.send(clientId, {
	// 		type: IpcMessageType.TaskEvent,
	// 		origin: IpcOrigin.Server,
	// 		data: { eventName: RooCodeEventName.Connect, taskId: -1 },
	// 	})
	// })

	const chunks = inChunksOf(tasks, 3)

	for (const chunk of chunks) {
		await Promise.all(
			chunk.map(async (task) => {
				if (task.finishedAt === null) {
					await runExercise({ run, task, server })
				}

				if (task.passed === null) {
					const passed = await runUnitTest({ task })
					await updateTask(task.id, { passed })
				}
			}),
		)

		break
	}

	const result = await finishRun(run.id)
	console.log("[cli#run]", result)
}

const runExercise = async ({ run, task, server }: { run: Run; task: Task; server: IpcServer }) => {
	const { language, exercise } = task
	const prompt = fs.readFileSync(path.resolve(exercisesPath, `prompts/${language}.md`), "utf-8")
	const dirname = path.dirname(run.socketPath)
	const taskSocketPath = path.resolve(dirname, `${dirname}/task-${task.id}.sock`)

	await execa({
		env: { ROO_CODE_IPC_SOCKET_PATH: taskSocketPath },
	})`code -n ${path.resolve(exercisesPath, language, exercise)}`

	console.log(`Connecting to ${taskSocketPath}`)
	let tries = 0
	let client = new IpcClient(taskSocketPath)

	while (++tries < 5) {
		try {
			await pWaitFor(() => client.isReady, { interval: 100, timeout: 2_000 })
			break
		} catch (error) {
			console.error(error)
			client.disconnect()
			client = new IpcClient(taskSocketPath)
		}
	}

	if (!client.isReady) {
		client.disconnect()
		console.log(`[cli#runExercise | ${language} / ${exercise}] unable to connect`)
		return
	}

	let isTaskFinished = false

	client.on(IpcMessageType.Disconnect, () => {
		console.log(`[cli#runExercise | ${language} / ${exercise}] disconnect`)
		isTaskFinished = true
	})

	const ignoreEvents = [
		RooCodeEventName.Message,
		RooCodeEventName.TaskTokenUsageUpdated,
		RooCodeEventName.TaskAskResponded,
	]

	let taskStartedAt = Date.now()
	let taskMetricsId: number | undefined
	let rooTaskId: string | undefined

	client.on(IpcMessageType.TaskEvent, async (taskEvent) => {
		const { eventName, payload } = taskEvent

		server.broadcast({
			type: IpcMessageType.TaskEvent,
			origin: IpcOrigin.Server,
			relayClientId: client.clientId!,
			data: { ...taskEvent, taskId: task.id },
		})

		if (!ignoreEvents.includes(eventName)) {
			console.log(`[cli#runExercise | ${language} / ${exercise}] taskEvent -> ${eventName}`)
		}

		if (eventName === RooCodeEventName.TaskStarted) {
			taskStartedAt = Date.now()

			const taskMetrics = await createTaskMetrics({
				cost: 0,
				tokensIn: 0,
				tokensOut: 0,
				tokensContext: 0,
				duration: 0,
				cacheWrites: 0,
				cacheReads: 0,
			})

			await updateTask(task.id, { taskMetricsId: taskMetrics.id, startedAt: new Date() })

			taskStartedAt = Date.now()
			taskMetricsId = taskMetrics.id
			rooTaskId = payload[0]
		}

		if (
			(eventName === RooCodeEventName.TaskTokenUsageUpdated || eventName === RooCodeEventName.TaskCompleted) &&
			taskMetricsId
		) {
			const duration = Date.now() - taskStartedAt

			const { totalCost, totalTokensIn, totalTokensOut, contextTokens, totalCacheWrites, totalCacheReads } =
				payload[1]

			await updateTaskMetrics(taskMetricsId, {
				cost: totalCost,
				tokensIn: totalTokensIn,
				tokensOut: totalTokensOut,
				tokensContext: contextTokens,
				duration,
				cacheWrites: totalCacheWrites ?? 0,
				cacheReads: totalCacheReads ?? 0,
			})
		}

		if (eventName === RooCodeEventName.TaskCompleted || eventName === RooCodeEventName.TaskAborted) {
			await updateTask(task.id, { finishedAt: new Date() })
			isTaskFinished = true
		}
	})

	client.sendMessage({
		type: IpcMessageType.TaskCommand,
		origin: IpcOrigin.Client,
		clientId: client.clientId!,
		data: {
			commandName: TaskCommandName.StartNewTask,
			data: {
				configuration: {
					...rooCodeDefaults,
					openRouterApiKey: process.env.OPENROUTER_API_KEY!,
					...run.settings,
				},
				text: prompt,
				newTab: true,
			},
		},
	})

	console.log(`[cli#runExercise | ${language} / ${exercise}] starting task`)

	try {
		await pWaitFor(() => isTaskFinished, { interval: 1_000, timeout: 1 * 60 * 1_000 })
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
	} catch (error) {
		console.log(`[cli#runExercise | ${language} / ${exercise}] time limit reached`)

		if (rooTaskId) {
			client.sendMessage({
				type: IpcMessageType.TaskCommand,
				origin: IpcOrigin.Client,
				clientId: client.clientId!,
				data: { commandName: TaskCommandName.CancelTask, data: rooTaskId },
			})

			await new Promise((resolve) => setTimeout(resolve, 2_000))
		}

		await updateTask(task.id, { finishedAt: new Date() })
	}

	try {
		client.sendMessage({
			type: IpcMessageType.VSCodeCommand,
			origin: IpcOrigin.Client,
			clientId: client.clientId!,
			data: "workbench.action.files.saveFiles",
		})

		client.sendMessage({
			type: IpcMessageType.VSCodeCommand,
			origin: IpcOrigin.Client,
			clientId: client.clientId!,
			data: "workbench.action.closeWindow",
		})

		client.disconnect()
	} catch (error) {
		console.error(error)
	}
}

const runUnitTest = async ({ task }: { task: Task }) => {
	const cmd = testCommands[task.language]
	const exercisePath = path.resolve(exercisesPath, task.language, task.exercise)
	const cwd = cmd.cwd ? path.resolve(exercisePath, cmd.cwd) : exercisePath
	const commands = cmd.commands.map((cs) => parseCommandString(cs))

	let passed = true

	for (const command of commands) {
		const controller = new AbortController()
		const cancelSignal = controller.signal
		const timeout = setTimeout(() => controller.abort(), cmd.timeout ?? 15_000)

		try {
			const result = await execa({ cwd, shell: true, reject: false, cancelSignal })`${command}`
			// console.log('[cli#run] execa result =', { ...result, cwd, command })

			clearTimeout(timeout)

			if (result.failed) {
				passed = false
				break
			}
		} catch (error) {
			console.log("[cli#run] execa error =", error)
			passed = false
			break
		}
	}

	return passed
}

const askLanguage = async (prompt: GluegunPrompt) => {
	const { language } = await prompt.ask<{ language: ExerciseLanguage }>({
		type: "select",
		name: "language",
		message: "Which language?",
		choices: [...exerciseLanguages],
	})

	return language
}

const askExercise = async (prompt: GluegunPrompt, language: ExerciseLanguage) => {
	const exercises = filesystem.subdirectories(path.join(exercisesPath, language))

	if (exercises.length === 0) {
		throw new Error(`No exercises found for ${language}`)
	}

	const { exercise } = await prompt.ask<{ exercise: string }>({
		type: "select",
		name: "exercise",
		message: "Which exercise?",
		choices: exercises.map((exercise) => path.basename(exercise)).filter((exercise) => !exercise.startsWith(".")),
	})

	return exercise
}

const main = async () => {
	const cli = build()
		.brand("cli")
		.src(__dirname)
		.help()
		.version()
		.command({
			name: "run",
			description: "Run a benchmark",
			run: ({ config, parameters }) => {
				config.language = parameters.first
				config.exercise = parameters.second

				if (parameters.options["runId"]) {
					config.runId = parameters.options["runId"]
				}
			},
		})
		.defaultCommand()
		.create()

	const toolbox = await cli.run(process.argv)
	const { command } = toolbox

	switch (command?.name) {
		case "run":
			await run(toolbox)
			break
	}

	process.exit(0)
}

if (!fs.existsSync(extensionDevelopmentPath)) {
	console.error(`"extensionDevelopmentPath" does not exist.`)
	process.exit(1)
}

if (!fs.existsSync(exercisesPath)) {
	console.error(
		`Exercises path does not exist. Please run "git clone https://github.com/cte/Roo-Code-Benchmark.git exercises".`,
	)
	process.exit(1)
}

main()
