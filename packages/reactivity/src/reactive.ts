// Vue 3响应式系统 - Reactive模块实现
// 此模块实现了Vue 3中的响应式对象系统，包括reactive、readonly等核心功能

import { def, hasOwn, isObject, toRawType } from '@vue/shared' // 共享工具函数
import {
  // 不同类型的代理处理器
  mutableHandlers, // 可变对象的处理器
  readonlyHandlers, // 只读对象的处理器
  shallowReactiveHandlers, // 浅层响应式处理器
  shallowReadonlyHandlers, // 浅层只读处理器
} from './baseHandlers'
import {
  // 集合类型的代理处理器
  mutableCollectionHandlers, // 可变集合处理器
  readonlyCollectionHandlers, // 只读集合处理器
  shallowCollectionHandlers, // 浅层集合处理器
  shallowReadonlyCollectionHandlers, // 浅层只读集合处理器
} from './collectionHandlers'
import type { RawSymbol, Ref, UnwrapRefSimple } from './ref' // ref相关类型导入
import { ReactiveFlags } from './constants' // 响应式相关常量
import { warn } from './warning' // 警告工具函数

/**
 * 目标对象接口
 * 定义了响应式对象的内部标记属性
 */
export interface Target {
  [ReactiveFlags.SKIP]?: boolean // 跳过响应式处理标记
  [ReactiveFlags.IS_REACTIVE]?: boolean // 是否为响应式对象标记
  [ReactiveFlags.IS_READONLY]?: boolean // 是否为只读对象标记
  [ReactiveFlags.IS_SHALLOW]?: boolean // 是否为浅层响应式标记
  [ReactiveFlags.RAW]?: any // 原始对象引用
}

// 各类响应式代理的缓存映射表
// 使用WeakMap保证不阻止垃圾回收
/**
 * 普通响应式对象的代理缓存
 */
export const reactiveMap: WeakMap<Target, any> = new WeakMap<Target, any>()

/**
 * 浅层响应式对象的代理缓存
 */
export const shallowReactiveMap: WeakMap<Target, any> = new WeakMap<
  Target,
  any
>()

/**
 * 只读对象的代理缓存
 */
export const readonlyMap: WeakMap<Target, any> = new WeakMap<Target, any>()

/**
 * 浅层只读对象的代理缓存
 */
export const shallowReadonlyMap: WeakMap<Target, any> = new WeakMap<
  Target,
  any
>()

/**
 * 目标对象类型枚举
 * 用于区分不同类型的对象，选择不同的代理处理策略
 */
enum TargetType {
  INVALID = 0, // 无效类型，不进行响应式处理
  COMMON = 1, // 普通对象/数组类型
  COLLECTION = 2, // 集合类型(Map/Set等)
}

/**
 * 根据对象的原始类型确定其目标类型
 * @param rawType - 通过toRawType获取的对象类型字符串
 * @returns 对应的TargetType枚举值
 */
function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON // 普通对象/数组
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION // 集合类型
    default:
      return TargetType.INVALID // 其他类型不进行响应式处理
  }
}

/**
 * 获取目标对象的类型，判断其是否可以被转为响应式
 * @param value - 要检查的目标对象
 * @returns 目标对象类型
 */
function getTargetType(value: Target) {
  // 已标记为跳过的对象或不可扩展对象被视为无效
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}

/**
 * 解包嵌套ref的类型
 * 仅解包嵌套的ref，不会递归解包对象中的ref
 */
export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>

/**
 * 响应式标记符号
 * 用于类型区分
 */
declare const ReactiveMarkerSymbol: unique symbol

/**
 * 响应式标记接口
 * 用于类型区分
 */
export interface ReactiveMarker {
  [ReactiveMarkerSymbol]?: void
}

/**
 * 响应式对象类型
 * 自动解包嵌套的ref并添加响应式标记
 */
export type Reactive<T> = UnwrapNestedRefs<T> &
  (T extends readonly any[] ? ReactiveMarker : {})

/**
 * 创建一个响应式对象
 *
 * 响应式转换是"深度"的：它影响所有嵌套属性。响应式对象还会深度解包任何引用类型的属性，同时保持响应性。
 *
 * @example
 * ```js
 * const obj = reactive({ count: 0 })
 * ```
 *
 * @param target - 源对象
 * @returns 响应式代理对象
 * @see {@link https://vuejs.org/api/reactivity-core.html#reactive}
 */
export function reactive<T extends object>(target: T): Reactive<T>
export function reactive(target: object) {
  // 如果尝试观察一个只读代理，返回该只读版本
  if (isReadonly(target)) {
    return target
  }
  // 创建响应式对象
  return createReactiveObject(
    target,
    false, // 不是只读
    mutableHandlers, // 可变处理器
    mutableCollectionHandlers, // 可变集合处理器
    reactiveMap, // 响应式对象缓存
  )
}

/**
 * 浅层响应式标记
 */
export declare const ShallowReactiveMarker: unique symbol

/**
 * 浅层响应式对象类型
 */
export type ShallowReactive<T> = T & { [ShallowReactiveMarker]?: true }

/**
 * 创建一个浅层响应式对象
 *
 * 与reactive不同，浅层响应式对象只有根级别的属性是响应式的。属性值按原样存储和暴露，这也意味着引用类型的属性不会自动解包。
 *
 * @example
 * ```js
 * const state = shallowReactive({
 *   foo: 1,
 *   nested: {
 *     bar: 2
 *   }
 * })
 *
 * // 修改state自身的属性是响应式的
 * state.foo++
 *
 * // 但不会转换嵌套对象
 * isReactive(state.nested) // false
 *
 * // 不是响应式的
 * state.nested.bar++
 * ```
 *
 * @param target - 源对象
 * @returns 浅层响应式代理对象
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#shallowreactive}
 */
export function shallowReactive<T extends object>(
  target: T,
): ShallowReactive<T> {
  return createReactiveObject(
    target,
    false, // 不是只读
    shallowReactiveHandlers, // 浅层响应式处理器
    shallowCollectionHandlers, // 浅层集合处理器
    shallowReactiveMap, // 浅层响应式对象缓存
  )
}

/**
 * 原始类型
 */
type Primitive = string | number | boolean | bigint | symbol | undefined | null

/**
 * 内置对象类型
 */
export type Builtin = Primitive | Function | Date | Error | RegExp

/**
 * 深度只读类型
 * 递归地将对象的所有属性转换为只读
 */
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends WeakMap<infer K, infer V>
        ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
        : T extends Set<infer U>
          ? ReadonlySet<DeepReadonly<U>>
          : T extends ReadonlySet<infer U>
            ? ReadonlySet<DeepReadonly<U>>
            : T extends WeakSet<infer U>
              ? WeakSet<DeepReadonly<U>>
              : T extends Promise<infer U>
                ? Promise<DeepReadonly<U>>
                : T extends Ref<infer U, unknown>
                  ? Readonly<Ref<DeepReadonly<U>>>
                  : T extends {}
                    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
                    : Readonly<T>

/**
 * 创建一个只读代理对象
 *
 * 接收一个对象（响应式或普通）或ref，返回原始对象的只读代理。
 *
 * 只读代理是深度的：访问的任何嵌套属性也将是只读的。它也具有与reactive相同的ref解包行为，
 * 但解包的值也会被设为只读。
 *
 * @example
 * ```js
 * const original = reactive({ count: 0 })
 *
 * const copy = readonly(original)
 *
 * watchEffect(() => {
 *   // 对响应式跟踪有效
 *   console.log(copy.count)
 * })
 *
 * // 修改原始对象会触发依赖于副本的监听器
 * original.count++
 *
 * // 修改副本将失败并导致警告
 * copy.count++ // 警告！
 * ```
 *
 * @param target - 源对象
 * @returns 只读代理对象
 * @see {@link https://vuejs.org/api/reactivity-core.html#readonly}
 */
export function readonly<T extends object>(
  target: T,
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true, // 是只读
    readonlyHandlers, // 只读处理器
    readonlyCollectionHandlers, // 只读集合处理器
    readonlyMap, // 只读对象缓存
  )
}

/**
 * 创建一个浅层只读代理对象
 *
 * 与readonly不同，浅层只读对象只有根级别的属性是只读的。属性值按原样存储和暴露，
 * 这也意味着引用类型的属性不会自动解包。
 *
 * @example
 * ```js
 * const state = shallowReadonly({
 *   foo: 1,
 *   nested: {
 *     bar: 2
 *   }
 * })
 *
 * // 修改state自身的属性会失败
 * state.foo++
 *
 * // 但可以修改嵌套对象
 * isReadonly(state.nested) // false
 *
 * // 有效
 * state.nested.bar++
 * ```
 *
 * @param target - 源对象
 * @returns 浅层只读代理对象
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#shallowreadonly}
 */
export function shallowReadonly<T extends object>(target: T): Readonly<T> {
  return createReactiveObject(
    target,
    true, // 是只读
    shallowReadonlyHandlers, // 浅层只读处理器
    shallowReadonlyCollectionHandlers, // 浅层只读集合处理器
    shallowReadonlyMap, // 浅层只读对象缓存
  )
}

/**
 * 创建响应式对象的核心函数
 * 被reactive、readonly等函数调用，共享创建响应式代理的逻辑
 *
 * @param target - 目标对象
 * @param isReadonly - 是否为只读
 * @param baseHandlers - 基本对象处理器
 * @param collectionHandlers - 集合对象处理器
 * @param proxyMap - 代理缓存映射表
 * @returns 响应式代理或原始对象
 */
function createReactiveObject(
  target: Target,
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>,
  proxyMap: WeakMap<Target, any>,
) {
  // 非对象类型不进行响应式处理
  if (!isObject(target)) {
    if (__DEV__) {
      warn(`值不能被设置为${isReadonly ? '只读' : '响应式'}: ${String(target)}`)
    }
    return target
  }
  // 目标已经是代理，直接返回
  // 例外情况：对响应式对象调用readonly()
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // 只对特定值类型进行观察
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }
  // 目标已经有对应的代理
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // 创建新的代理
  // 根据目标类型选择不同的处理器
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers,
  )
  // 缓存代理
  proxyMap.set(target, proxy)
  return proxy
}

/**
 * 检查一个对象是否是由reactive或shallowReactive创建的代理（某些情况下也包括ref）
 *
 * @example
 * ```js
 * isReactive(reactive({}))            // => true
 * isReactive(readonly(reactive({})))  // => true
 * isReactive(ref({}).value)           // => true
 * isReactive(readonly(ref({})).value) // => true
 * isReactive(ref(true))               // => false
 * isReactive(shallowRef({}).value)    // => false
 * isReactive(shallowReactive({}))     // => true
 * ```
 *
 * @param value - 要检查的值
 * @returns 判断结果
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isreactive}
 */
export function isReactive(value: unknown): boolean {
  // 处理只读代理中包含的响应式对象
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  // 检查响应式标记
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}

/**
 * 检查一个对象是否是只读代理
 * 只读对象的属性可以改变，但不能通过代理直接赋值修改
 *
 * 由readonly和shallowReadonly创建的代理都被视为只读，没有set函数的计算ref也被视为只读
 *
 * @param value - 要检查的值
 * @returns 判断结果
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isreadonly}
 */
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

/**
 * 检查一个对象是否是浅层响应式代理
 *
 * @param value - 要检查的值
 * @returns 判断结果
 */
export function isShallow(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_SHALLOW])
}

/**
 * 检查一个对象是否是由reactive、readonly、shallowReactive或shallowReadonly创建的代理
 *
 * @param value - 要检查的值
 * @returns 判断结果
 * @see {@link https://vuejs.org/api/reactivity-utilities.html#isproxy}
 */
export function isProxy(value: any): boolean {
  return value ? !!value[ReactiveFlags.RAW] : false
}

/**
 * 返回Vue创建的代理的原始对象
 *
 * toRaw()可以返回由reactive、readonly、shallowReactive或shallowReadonly创建的代理的原始对象
 *
 * 这是一个逃逸舱，可以用来临时读取而不会产生代理访问/跟踪开销，或写入而不触发更改。
 * **不建议**持有对原始对象的持久引用。谨慎使用。
 *
 * @example
 * ```js
 * const foo = {}
 * const reactiveFoo = reactive(foo)
 *
 * console.log(toRaw(reactiveFoo) === foo) // true
 * ```
 *
 * @param observed - 要获取原始值的代理对象
 * @returns 原始对象
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#toraw}
 */
export function toRaw<T>(observed: T): T {
  // 递归获取原始对象
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

/**
 * 原始对象类型
 */
export type Raw<T> = T & { [RawSymbol]?: true }

/**
 * 标记一个对象使其永远不会被转换为代理。返回对象本身。
 *
 * @example
 * ```js
 * const foo = markRaw({})
 * console.log(isReactive(reactive(foo))) // false
 *
 * // 嵌套在其他响应式对象中也有效
 * const bar = reactive({ foo })
 * console.log(isReactive(bar.foo)) // false
 * ```
 *
 * **警告:** markRaw()与shallowReactive等浅层API一起使用，允许你选择性地退出默认的深度响应式/只读转换，
 * 并在你的状态图中嵌入原始的、非代理的对象。
 *
 * @param value - 要标记为"原始"的对象
 * @returns 标记后的对象
 * @see {@link https://vuejs.org/api/reactivity-advanced.html#markraw}
 */
export function markRaw<T extends object>(value: T): Raw<T> {
  // 检查对象是否已经有SKIP标记且可扩展
  if (!hasOwn(value, ReactiveFlags.SKIP) && Object.isExtensible(value)) {
    // 使用Object.defineProperty定义不可枚举的SKIP属性
    def(value, ReactiveFlags.SKIP, true)
  }
  return value
}

/**
 * 返回给定值的响应式代理（如果可能）
 *
 * 如果给定值不是对象，则返回原始值本身
 *
 * @param value - 要创建响应式代理的值
 * @returns 响应式代理或原始值
 */
export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

/**
 * 返回给定值的只读代理（如果可能）
 *
 * 如果给定值不是对象，则返回原始值本身
 *
 * @param value - 要创建只读代理的值
 * @returns 只读代理或原始值
 */
export const toReadonly = <T extends unknown>(value: T): DeepReadonly<T> =>
  isObject(value) ? readonly(value) : (value as DeepReadonly<T>)
