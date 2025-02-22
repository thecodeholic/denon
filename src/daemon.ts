// Copyright 2020-present the denosaurs team. All rights reserved. MIT license.

import log from "./log.ts";

import { Denon, DenonEvent } from "../denon.ts";
import { CompleteDenonConfig } from "./config.ts";
import { ScriptOptions } from "./scripts.ts";

const logger = log.prefix("daem");

/** Daemon instance.
 * Returned by Denon instance when
 * `start(script)` is called. It can be used in a for
 * loop to listen to DenonEvents. */
export class Daemon implements AsyncIterable<DenonEvent> {
  #denon: Denon;
  #script: string;
  #config: CompleteDenonConfig;
  #processes: { [pid: number]: Deno.Process } = {};

  constructor(denon: Denon, script: string) {
    this.#denon = denon;
    this.#script = script;
    this.#config = denon.config; // just as a shortcut
  }

  /** Restart current process. */
  private async reload(): Promise<void> {
    if (this.#config.logger && this.#config.logger.fullscreen) {
      logger.debug("clearing screen");
      console.clear();
    }

    if (this.#config.watcher.match) {
      logger.info(`watching path(s): ${this.#config.watcher.match.join(" ")}`);
    }
    if (this.#config.watcher.exts) {
      logger.info(
        `watching extensions: ${this.#config.watcher.exts.join(",")}`,
      );
    }
    logger.info("restarting due to changes...");

    this.killAll();

    await this.start();
  }

  private async start(): Promise<ScriptOptions> {
    const commands = this.#denon.runner.build(this.#script);

    // Sequential execution, one process after another is executed,
    // *sequentially*, the last process is named `main` and is the
    // one that will actually be demonized.
    for (let i = 0; i < commands.length; i++) {
      const plog = log.prefix(`#${i}`);
      const command = commands[i];
      let process = command.exe();
      plog.debug(`starting process with pid ${process.pid}`);

      if (i === commands.length - 1) {
        plog.warning(`starting main \`${command.cmd.join(" ")}\``);
        this.#processes[process.pid] = process;
        this.monitor(process, command.options);
        return command.options;
      }

      plog.info(`starting sequential \`${command.cmd.join(" ")}\``);
      await process.status();
      process.close();
    }
    return {};
  }

  private killAll(): void {
    logger.debug(
      `killing ${Object.keys(this.#processes).length} orphan process[es]`,
    );
    // kill all processes spawned
    let pcopy = Object.assign({}, this.#processes);
    this.#processes = {};
    for (let id in pcopy) {
      const p = pcopy[id];
      if (Deno.build.os === "windows") {
        logger.debug(`closing (windows) process with pid ${p.pid}`);
        p.close();
      } else {
        logger.debug(`killing (unix) process with pid ${p.pid}`);
        Deno.kill(p.pid, Deno.Signal.SIGKILL);
      }
    }
  }

  private async monitor(
    process: Deno.Process,
    options: ScriptOptions,
  ): Promise<void> {
    logger.debug(`monitoring status of process with pid ${process.pid}`);
    const pid = process.pid;
    let s: Deno.ProcessStatus | undefined;
    try {
      s = await process.status();
      process.close();
      logger.debug(`got status of process with pid ${process.pid}`);
    } catch (error) {
      logger.debug(`error getting status of process with pid ${process.pid}`);
    }
    let p = this.#processes[pid];
    if (p) {
      logger.debug(`process with pid ${process.pid} exited on its own`);
      // process exited on its own, so we should wait a reload
      // remove it from processes array as it is already dead
      delete this.#processes[pid];

      if (s) {
        // logger status status
        if (s.success) {
          if (options.watch) {
            logger.info("clean exit - waiting for changes before restart");
          } else {
            logger.info("clean exit - denon is exiting ...");
          }
        } else {
          if (options.watch) {
            logger.error(
              "app crashed - waiting for file changes before starting ...",
            );
          } else {
            logger.error("app crashed - denon is exiting ...");
          }
        }
      }
    } else {
      logger.debug(`process with pid ${process.pid} was killed`);
    }
  }

  private async onExit(): Promise<void> {
    if (Deno.build.os !== "windows") {
      const signs = [
        Deno.Signal.SIGHUP,
        Deno.Signal.SIGINT,
        Deno.Signal.SIGTERM,
        Deno.Signal.SIGTSTP,
      ];
      signs.forEach((s) => {
        (async () => {
          await Deno.signal(s);
          this.killAll();
          Deno.exit(0);
        })();
      });
    }
  }

  async *iterate(): AsyncIterator<DenonEvent> {
    yield {
      type: "start",
    };
    const options = await this.start();
    this.onExit();
    if (options.watch) {
      for await (const watchE of this.#denon.watcher) {
        if (watchE.some((_) => _.type.includes("modify"))) {
          logger.debug(
            `reload event detected, starting the reload procedure...`,
          );
          yield {
            type: "reload",
            change: watchE,
          };
          await this.reload();
        }
      }
    }
    yield {
      type: "exit",
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<DenonEvent> {
    return this.iterate();
  }
}
