// Vue 3响应式系统 - Watch模块实现
// 此模块实现了Vue 3中的监听功能，包括watch、watchEffect等核心API

import {
  // 共享工具函数
  EMPTY_OBJ, // 空对象常量
  NOOP, // 空操作函数
  hasChanged, // 检查值是否变化
  isArray, // 检查是否为数组
  isFunction, // 检查是否为函数
  isMap, // 检查是否为Map
  isObject, // 检查是否为对象
  isPlainObject, // 检查是否为普通对象
  isSet, // 检查是否为Set
  remove, // 从数组中移除元素
} from '@vue/shared'
import { warn } from './warning' // 警告工具函数
import type { ComputedRef } from './computed' // 计算属性引用类型
import { ReactiveFlags } from './constants' // 响应式相关常量
import {
  // 副作用相关导入
  type DebuggerOptions, // 调试器选项类型
  EffectFlags, // 副作用标志枚举
  type EffectScheduler, // 副作用调度器类型
  ReactiveEffect, // 响应式副作用类
  pauseTracking, // 暂停依赖跟踪
  resetTracking, // 重置依赖跟踪
} from './effect'
import { isReactive, isShallow } from './reactive' // 响应式检查函数
import { type Ref, isRef } from './ref' // 引用类型及检查函数
import { getCurrentScope } from './effectScope' // 获取当前作用域

// 这些错误码从 `packages/runtime-core/src/errorHandling.ts` 转移到 @vue/reactivity
// 以便与移动的基础watch逻辑共存，因此保持这些值不变至关重要
/**
 * 监听相关错误码枚举
 */
export enum WatchErrorCodes {
  WATCH_GETTER = 2, // watch getter函数错误
  WATCH_CALLBACK, // watch回调函数错误
  WATCH_CLEANUP, // watch清理函数错误
}

/**
 * 监听副作用函数类型
 * @param onCleanup - 清理函数注册回调
 */
export type WatchEffect = (onCleanup: OnCleanup) => void

/**
 * 监听数据源类型
 * 可以是ref、computed ref或getter函数
 */
export type WatchSource<T = any> = Ref<T, any> | ComputedRef<T> | (() => T)

/**
 * 监听回调函数类型
 * @param value - 新值
 * @param oldValue - 旧值
 * @param onCleanup - 清理函数注册回调
 */
export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onCleanup: OnCleanup,
) => any

/**
 * 清理函数注册器类型
 * 用于注册在下次副作用运行前执行的清理函数
 */
export type OnCleanup = (cleanupFn: () => void) => void

/**
 * 监听选项接口
 */
export interface WatchOptions<Immediate = boolean> extends DebuggerOptions {
  immediate?: Immediate // 是否立即执行一次
  deep?: boolean | number // 是否深度监听，可以是布尔值或深度数字
  once?: boolean // 是否只执行一次
  scheduler?: WatchScheduler // 自定义调度器
  onWarn?: (msg: string, ...args: any[]) => void // 自定义警告处理函数
  /**
   * @internal 内部API：增强作业函数
   */
  augmentJob?: (job: (...args: any[]) => void) => void
  /**
   * @internal 内部API：调用函数包装器
   */
  call?: (
    fn: Function | Function[],
    type: WatchErrorCodes,
    args?: unknown[],
  ) => void
}

/**
 * 监听停止函数类型
 */
export type WatchStopHandle = () => void

/**
 * 监听句柄接口，扩展了停止功能
 */
export interface WatchHandle extends WatchStopHandle {
  pause: () => void // 暂停监听
  resume: () => void // 恢复监听
  stop: () => void // 停止监听
}

// 监听器的初始值，用于在undefined初始值时触发
const INITIAL_WATCHER_VALUE = {}

/**
 * 监听调度器类型
 */
export type WatchScheduler = (job: () => void, isFirstRun: boolean) => void

// 存储副作用清理函数的WeakMap
const cleanupMap: WeakMap<ReactiveEffect, (() => void)[]> = new WeakMap()
// 当前活动的监听器
let activeWatcher: ReactiveEffect | undefined = undefined

/**
 * 返回当前活动的副作用（如果有）
 */
export function getCurrentWatcher(): ReactiveEffect<any> | undefined {
  return activeWatcher
}

/**
 * 在当前活动的副作用上注册清理回调。
 * 注册的清理回调将在相关副作用重新运行之前被调用。
 *
 * @param cleanupFn - 要附加到副作用清理的回调函数
 * @param failSilently - 如果为`true`，当没有活动副作用时调用不会抛出警告
 * @param owner - 此清理函数应该附加到的副作用。默认为当前活动的副作用
 */
export function onWatcherCleanup(
  cleanupFn: () => void,
  failSilently = false,
  owner: ReactiveEffect | undefined = activeWatcher,
): void {
  if (owner) {
    let cleanups = cleanupMap.get(owner)
    if (!cleanups) cleanupMap.set(owner, (cleanups = []))
    cleanups.push(cleanupFn)
  } else if (__DEV__ && !failSilently) {
    warn(
      `onWatcherCleanup() was called when there was no active watcher` +
        ` to associate with.`,
    )
  }
}

/**
 * 创建侦听器，用于观察响应式数据的变化
 *
 * Vue的watch API完全等效于组件watch选项。watch需要监听特定的数据源，并在回调函数中执行副作用。
 * 默认情况下，它是惰性的，即只有当被侦听的源发生变化时才执行回调。
 *
 * @example
 * ```js
 * // 侦听单个源
 * const state = reactive({ count: 0 })
 * // getter函数
 * watch(() => state.count, (count, prevCount) => {})
 * // 直接侦听ref
 * const count = ref(0)
 * watch(count, (count, prevCount) => {})
 *
 * // 侦听多个源
 * watch([fooRef, barRef], ([foo, bar], [prevFoo, prevBar]) => {})
 * ```
 *
 * @param source - 监听源，可以是ref、reactive对象、getter函数、数组或watchEffect函数
 * @param cb - 回调函数，当源变化时执行
 * @param options - 监听选项配置
 * @returns 包含stop方法的侦听器句柄，调用可以停止监听
 */
export function watch(
  source: WatchSource | WatchSource[] | WatchEffect | object,
  cb?: WatchCallback | null,
  options: WatchOptions = EMPTY_OBJ,
): WatchHandle {
  const { immediate, deep, once, scheduler, augmentJob, call } = options

  // 警告无效的监听源
  const warnInvalidSource = (s: unknown) => {
    ;(options.onWarn || warn)(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`,
    )
  }

  // 响应式对象的getter函数
  const reactiveGetter = (source: object) => {
    // deep为true时直接返回源对象，深度遍历将在下面的包装getter中进行
    if (deep) return source
    // 对于`deep: false | 0`或浅层响应式，只遍历根级属性
    if (isShallow(source) || deep === false || deep === 0)
      return traverse(source, 1)
    // 对于`deep: undefined`的响应式对象，深度遍历所有属性
    return traverse(source)
  }

  let effect: ReactiveEffect
  let getter: () => any // 用于获取监听值的函数
  let cleanup: (() => void) | undefined // 清理函数
  let boundCleanup: typeof onWatcherCleanup // 绑定到当前副作用的清理函数注册器
  let forceTrigger = false // 是否强制触发
  let isMultiSource = false // 是否为多源监听

  // 根据监听源的类型设置getter函数
  if (isRef(source)) {
    // ref类型的源
    getter = () => source.value
    forceTrigger = isShallow(source)
  } else if (isReactive(source)) {
    // reactive对象类型的源
    getter = () => reactiveGetter(source)
    forceTrigger = true
  } else if (isArray(source)) {
    // 数组类型的多源监听
    isMultiSource = true
    forceTrigger = source.some(s => isReactive(s) || isShallow(s))
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return reactiveGetter(s)
        } else if (isFunction(s)) {
          return call ? call(s, WatchErrorCodes.WATCH_GETTER) : s()
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // 有回调的getter函数
      getter = call
        ? () => call(source, WatchErrorCodes.WATCH_GETTER)
        : (source as () => any)
    } else {
      // 无回调的watchEffect形式
      getter = () => {
        if (cleanup) {
          pauseTracking()
          try {
            cleanup()
          } finally {
            resetTracking()
          }
        }
        const currentEffect = activeWatcher
        activeWatcher = effect
        try {
          return call
            ? call(source, WatchErrorCodes.WATCH_CALLBACK, [boundCleanup])
            : source(boundCleanup)
        } finally {
          activeWatcher = currentEffect
        }
      }
    }
  } else {
    // 无效的源类型
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 如果有回调且需要深度监听，包装getter以执行深度遍历
  if (cb && deep) {
    const baseGetter = getter
    const depth = deep === true ? Infinity : deep
    getter = () => traverse(baseGetter(), depth)
  }

  // 获取当前的作用域
  const scope = getCurrentScope()
  // 创建停止监听的函数
  const watchHandle: WatchHandle = () => {
    effect.stop()
    if (scope && scope.active) {
      remove(scope.effects, effect)
    }
  }

  // 如果配置为只执行一次，包装回调
  if (once && cb) {
    const _cb = cb
    cb = (...args) => {
      _cb(...args)
      watchHandle()
    }
  }

  // 初始化旧值，多源监听时使用数组填充初始值
  let oldValue: any = isMultiSource
    ? new Array((source as []).length).fill(INITIAL_WATCHER_VALUE)
    : INITIAL_WATCHER_VALUE

  // 监听作业函数，在源变化或需要立即执行时调用
  const job = (immediateFirstRun?: boolean) => {
    if (
      !(effect.flags & EffectFlags.ACTIVE) ||
      (!effect.dirty && !immediateFirstRun)
    ) {
      return
    }
    if (cb) {
      // watch(source, cb)模式
      const newValue = effect.run()
      if (
        deep ||
        forceTrigger ||
        (isMultiSource
          ? (newValue as any[]).some((v, i) => hasChanged(v, oldValue[i]))
          : hasChanged(newValue, oldValue))
      ) {
        // 在再次运行回调之前执行清理
        if (cleanup) {
          cleanup()
        }
        const currentWatcher = activeWatcher
        activeWatcher = effect
        try {
          const args = [
            newValue,
            // 第一次变化时，旧值为undefined
            oldValue === INITIAL_WATCHER_VALUE
              ? undefined
              : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE
                ? []
                : oldValue,
            boundCleanup,
          ]
          oldValue = newValue
          call
            ? call(cb!, WatchErrorCodes.WATCH_CALLBACK, args)
            : // @ts-expect-error
              cb!(...args)
        } finally {
          activeWatcher = currentWatcher
        }
      }
    } else {
      // watchEffect模式
      effect.run()
    }
  }

  // 如果有增强作业函数，应用它
  if (augmentJob) {
    augmentJob(job)
  }

  // 创建响应式副作用
  effect = new ReactiveEffect(getter)

  // 设置调度器
  effect.scheduler = scheduler
    ? () => scheduler(job, false)
    : (job as EffectScheduler)

  // 绑定清理函数注册器到当前副作用
  boundCleanup = fn => onWatcherCleanup(fn, false, effect)

  // 副作用停止时执行的清理函数
  cleanup = effect.onStop = () => {
    const cleanups = cleanupMap.get(effect)
    if (cleanups) {
      if (call) {
        call(cleanups, WatchErrorCodes.WATCH_CLEANUP)
      } else {
        for (const cleanup of cleanups) cleanup()
      }
      cleanupMap.delete(effect)
    }
  }

  // 开发环境下设置调试跟踪
  if (__DEV__) {
    effect.onTrack = options.onTrack
    effect.onTrigger = options.onTrigger
  }

  // 初始运行
  if (cb) {
    if (immediate) {
      job(true)
    } else {
      oldValue = effect.run()
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true)
  } else {
    effect.run()
  }

  // 设置暂停、恢复和停止方法
  watchHandle.pause = effect.pause.bind(effect)
  watchHandle.resume = effect.resume.bind(effect)
  watchHandle.stop = watchHandle

  return watchHandle
}

/**
 * 深度遍历一个对象，触发生命中的getter，用于实现深度监听
 *
 * @param value - 要遍历的值
 * @param depth - 遍历深度，默认为无限深度
 * @param seen - 已访问对象的映射，避免循环引用
 * @returns 原始值
 */
export function traverse(
  value: unknown,
  depth: number = Infinity,
  seen?: Map<unknown, number>,
): unknown {
  // 如果深度为0、不是对象或标记为跳过，直接返回
  if (depth <= 0 || !isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }

  seen = seen || new Map()
  // 避免重复遍历或过深的遍历
  if ((seen.get(value) || 0) >= depth) {
    return value
  }
  seen.set(value, depth)
  depth--

  // 针对不同类型的对象进行遍历
  if (isRef(value)) {
    traverse(value.value, depth, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], depth, seen)
    }
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, depth, seen)
    })
  } else if (isPlainObject(value)) {
    // 遍历普通对象的所有属性
    for (const key in value) {
      traverse(value[key], depth, seen)
    }
    // 遍历Symbol类型的属性
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse(value[key as any], depth, seen)
      }
    }
  }
  return value
}
