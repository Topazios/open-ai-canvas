import type { TaskBuilder, TaskKind } from "../contracts";
import { imageTaskBuilder, type ImageTaskBuildInput } from "./image";

// 构造器注册表：按任务类型查找构造器。未迁移的类型返回 undefined，调用方继续走 legacy 路径。
export type TaskBuilderInputs = {
    image: ImageTaskBuildInput;
};

type RegisteredKind = keyof TaskBuilderInputs & TaskKind;

const builders: { [K in RegisteredKind]: TaskBuilder<K, TaskBuilderInputs[K]> } = {
    image: imageTaskBuilder,
};

export function getTaskBuilder<K extends RegisteredKind>(kind: K): TaskBuilder<K, TaskBuilderInputs[K]>;
export function getTaskBuilder(kind: TaskKind): TaskBuilder<TaskKind, unknown> | undefined;
export function getTaskBuilder(kind: TaskKind) {
    return (builders as Partial<Record<TaskKind, TaskBuilder<TaskKind, unknown>>>)[kind];
}

export function registeredTaskKinds(): RegisteredKind[] {
    return Object.keys(builders) as RegisteredKind[];
}
