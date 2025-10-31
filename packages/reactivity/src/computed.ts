// Vue 3响应式系统 - 计算属性模块
// 此模块实现了Vue 3响应式系统中的计算属性功能，包括只读计算属性和可写计算属性

import { isFunction } from '@vue/shared' // 工具函数，判断是否为函数
import {
  type DebuggerEvent,
  type DebuggerOptions,
  EffectFlags,
  type Subscriber,
  activeSub,
  batch,
  refreshComputed,
} from './effect' // 副作用相关导入
import type { Ref } from './ref' // 引用类型导入
import { warn } from './warning' // 警告函数
import { Dep, type Link, globalVersion } from './dep' // 依赖相关导入
import { ReactiveFlags, TrackOpTypes } from './constants' // 常量和标记导入

// 计算引用的唯一标识符
declare const ComputedRefSymbol: unique symbol
// 可写计算引用的唯一标识符
declare const WritableComputedRefSymbol: unique symbol

/**
 * 计算引用的基础接口
 * @template T - 计算值的类型
 * @template S - 设置值的类型（默认为T）
 */
interface BaseComputedRef<T, S = T> extends Ref<T, S> {
  [ComputedRefSymbol]: true
  /**
   * @deprecated computed no longer uses effect
   */
  effect: ComputedRefImpl
}

/**
 * 只读计算引用接口
 * @template T - 计算值的类型
 */
export interface ComputedRef<T = any> extends BaseComputedRef<T> {
  readonly value: T
}

/**
 * 可写计算引用接口
 * @template T - 计算值的类型
 * @template S - 设置值的类型（默认为T）
 */
export interface WritableComputedRef<T, S = T> extends BaseComputedRef<T, S> {
  [WritableComputedRefSymbol]: true
}

/**
 * 计算属性的getter函数类型
 * @template T - 返回值类型
 */
export type ComputedGetter<T> = (oldValue?: T) => T

/**
 * 计算属性的setter函数类型
 * @template T - 设置值的类型
 */
export type ComputedSetter<T> = (newValue: T) => void

/**
 * 可写计算属性的选项接口
 * @template T - 计算值的类型
 * @template S - 设置值的类型（默认为T）
 */
export interface WritableComputedOptions<T, S = T> {
  get: ComputedGetter<T>
  set: ComputedSetter<S>
}

/**
 * 计算引用实现类
 * 这是计算属性的核心实现，继承自Subscriber接口
 * @internal
 */
export class ComputedRefImpl<T = any> implements Subscriber {
  /**
   * @internal
   * 计算属性的缓存值
   */
  _value: any = undefined
  /**
   * @internal
   * 此计算属性的依赖实例，用于追踪订阅此计算属性的副作用
   */
  readonly dep: Dep = new Dep(this)
  /**
   * @internal
   * 标记为ref类型，用于类型检查
   */
  readonly __v_isRef = true
  // TODO isolatedDeclarations ReactiveFlags.IS_REF
  /**
   * @internal
   * 标记为只读或可写
   */
  readonly __v_isReadonly: boolean
  // TODO isolatedDeclarations ReactiveFlags.IS_READONLY
  // 计算属性也是一个订阅者，追踪其他依赖
  /**
   * @internal
   * 此计算属性依赖的其他响应式数据链表头部
   */
  deps?: Link = undefined
  /**
   * @internal
   * 此计算属性依赖的其他响应式数据链表尾部
   */
  depsTail?: Link = undefined
  /**
   * @internal
   * 计算属性的状态标志
   * 初始为DIRTY状态，表示需要重新计算
   */
  flags: EffectFlags = EffectFlags.DIRTY
  /**
   * @internal
   * 全局版本号，用于快速判断是否需要重新计算
   */
  globalVersion: number = globalVersion - 1
  /**
   * @internal
   * 是否在SSR环境中
   */
  isSSR: boolean
  /**
   * @internal
   * 副作用队列中的下一个订阅者
   */
  next?: Subscriber = undefined

  // 向后兼容
  effect: this = this
  // 开发环境下的调试钩子
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  /**
   * 开发环境下防止递归警告
   * @internal
   */
  _warnRecursive?: boolean

  /**
   * 构造函数
   * @param fn - 计算属性的getter函数
   * @param setter - 计算属性的setter函数（只读计算属性为undefined）
   * @param isSSR - 是否在SSR环境中
   */
  constructor(
    public fn: ComputedGetter<T>,
    private readonly setter: ComputedSetter<T> | undefined,
    isSSR: boolean,
  ) {
    this[ReactiveFlags.IS_READONLY] = !setter
    this.isSSR = isSSR
  }

  /**
   * @internal
   * 当依赖变化时被通知
   * @returns 是否为计算属性并需要继续通知订阅者
   */
  notify(): true | void {
    // 标记为需要重新计算
    this.flags |= EffectFlags.DIRTY
    if (
      !(this.flags & EffectFlags.NOTIFIED) &&
      // 避免无限自递归
      activeSub !== this
    ) {
      // 将此计算属性加入更新队列
      batch(this, true)
      return true // 返回true表示这是计算属性，需要继续通知其订阅者
    } else if (__DEV__) {
      // TODO warn
    }
  }

  /**
   * 获取计算属性的值
   * 实现了懒计算和缓存逻辑
   */
  get value(): T {
    // 追踪对计算属性的访问，收集订阅者
    const link = __DEV__
      ? this.dep.track({
          target: this,
          type: TrackOpTypes.GET,
          key: 'value',
        })
      : this.dep.track()

    // 刷新计算属性的值（如果需要）
    refreshComputed(this)

    // 同步版本号
    if (link) {
      link.version = this.dep.version
    }

    return this._value
  }

  /**
   * 设置计算属性的值
   * 只在可写计算属性中有效
   */
  set value(newValue) {
    if (this.setter) {
      // 调用setter函数设置值
      this.setter(newValue)
    } else if (__DEV__) {
      // 只读计算属性不允许设置值
      warn('Write operation failed: computed value is readonly')
    }
  }
}

/**
 * 创建计算属性
 *
 * 接受一个getter函数并返回一个只读的响应式ref对象，或者接受一个具有get和set函数的对象以创建可写的ref对象。
 *
 * @example
 * ```js
 * // 创建只读计算属性:
 * const count = ref(1)
 * const plusOne = computed(() => count.value + 1)
 *
 * console.log(plusOne.value) // 2
 * plusOne.value++ // 错误
 * ```
 *
 * ```js
 * // 创建可写计算属性:
 * const count = ref(1)
 * const plusOne = computed({
 *   get: () => count.value + 1,
 *   set: (val) => {
 *     count.value = val - 1
 *   }
 * })
 *
 * plusOne.value = 1
 * console.log(count.value) // 0
 * ```
 *
 * @param getter - 生成下一个值的函数
 * @param debugOptions - 用于调试的选项
 * @see {@link https://vuejs.org/api/reactivity-core.html#computed}
 */
export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions,
): ComputedRef<T>
export function computed<T, S = T>(
  options: WritableComputedOptions<T, S>,
  debugOptions?: DebuggerOptions,
): WritableComputedRef<T, S>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false,
) {
  // 解析getter和setter
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T> | undefined

  // 如果是函数，则为只读计算属性
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
  } else {
    // 否则为可写计算属性
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  // 创建计算引用实例
  const cRef = new ComputedRefImpl(getter, setter, isSSR)

  // 开发环境下设置调试选项
  if (__DEV__ && debugOptions && !isSSR) {
    cRef.onTrack = debugOptions.onTrack
    cRef.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
