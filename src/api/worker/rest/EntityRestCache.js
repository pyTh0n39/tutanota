// @flow
import {EntityRestClient, typeRefToPath} from "./EntityRestClient"
import type {HttpMethodEnum, ListElement} from "../../common/EntityFunctions"
import {
	firstBiggerThanSecond,
	GENERATED_MAX_ID,
	GENERATED_MIN_ID,
	getLetId,
	HttpMethod,
	isSameTypeRef,
	resolveTypeReference,
	TypeRef
} from "../../common/EntityFunctions"
import {OperationType} from "../../common/TutanotaConstants"
import {remove} from "../../common/utils/ArrayUtils"
import {clone, downcast, neverNull} from "../../common/utils/Utils"
import {PermissionTypeRef} from "../../entities/sys/Permission"
import {EntityEventBatchTypeRef} from "../../entities/sys/EntityEventBatch"
import {assertWorkerOrNode} from "../../Env"
import EC from "../../common/EntityConstants"
import {SessionTypeRef} from "../../entities/sys/Session"
import {StatisticLogEntryTypeRef} from "../../entities/tutanota/StatisticLogEntry"
import {BucketPermissionTypeRef} from "../../entities/sys/BucketPermission"
import {SecondFactorTypeRef} from "../../entities/sys/SecondFactor"
import {RecoverCodeTypeRef} from "../../entities/sys/RecoverCode"

const ValueType = EC.ValueType

assertWorkerOrNode()

/**
 * This implementation provides a caching mechanism to the rest chain.
 * It forwards requests to the entity rest client.
 * The cache works as follows:
 * If a read from the target fails, the request fails.
 * If a read from the target is successful, the cache is written and the element returned.
 * For LETs the cache stores one range per list id. if a range is requested starting in the stored range or at the range ends the missing elements are loaded from the server.
 * Only ranges with elements with generated ids are stored in the cache. Custom id elements are only stored as single element currently. If needed this has to be extended for ranges.
 * Range requests starting outside the stored range are only allowed if the direction is away from the stored range. In this case we load from the range end to avoid gaps in the stored range.
 * Requests for creating or updating elements are always forwarded and not directly stored in the cache.
 * On EventBusClient notifications updated elements are stored in the cache if the element already exists in the cache.
 * On EventBusClient notifications new elements are only stored in the cache if they are LETs and in the stored range.
 * On EventBusClient notifications deleted elements are removed from the cache.
 *
 * Range handling:
 * |          <|>        c d e f g h i j k      <|>             |
 * MIN_ID  lowerRangeId     ids in rage    upperRangeId    MAX_ID
 * lowerRangeId may be anything from MIN_ID to c, upperRangeId may be anything from k to MAX_ID
 */
export class EntityRestCache implements EntityRestInterface {

	_ignoredTypes: TypeRef<any>[];

	_entityRestClient: EntityRestClient;
	/**
	 * stores all contents that would be stored on the server, otherwise
	 */
	_entities: {[key: string]: {[key: Id]: Object}};
	//	Example:
	//	_entities = {
	//		'path': { 		// element type
	//			'element1Id': 'element1',
	//			'element2Id': 'element2'
	//		    // and so on
	//		},
	//      // and so on
	//  }
	_listEntities: {[key: string]: {[key: Id]: {allRange: Id[], lowerRangeId: Id, upperRangeId: Id, elements: {[key: Id]: Object}}}};
	//	Example:
	//    _listEntities {
	//		'path': { 		// list element type
	//			'listId': {
	//				allRange: ['listElement1Id', 'listElement2Id'],
	//              lowerRangeId: listElement1Id,
	//              upperRangeId: GENERATED_MAX_ID,
	//              elements: {
	//				    'listElement1Id': 'listElement1',
	//				    'listElement2Id': 'listElement2',
	//    				// and so on
	//              }
	//			},
	//          // and so on
	//		},
	//      // and so on
	//	}
	constructor(entityRestClient: EntityRestClient) {
		this._entityRestClient = entityRestClient
		this._entities = {}
		this._listEntities = {}
		this._ignoredTypes = [
			EntityEventBatchTypeRef, PermissionTypeRef, BucketPermissionTypeRef, SessionTypeRef,
			StatisticLogEntryTypeRef, SecondFactorTypeRef, RecoverCodeTypeRef
		]
	}

	entityRequest<T>(typeRef: TypeRef<T>, method: HttpMethodEnum, listId: ?Id, id: ?Id, entity: ?T, queryParameter: ?Params, extraHeaders?: Params): Promise<any> {
		if (method === HttpMethod.GET && !this._ignoredTypes.find(ref => isSameTypeRef(typeRef, ref))) {
			if ((typeRef.app === "monitor") || (queryParameter && queryParameter["version"])) {
				// monitor app and version requests are never cached
				return this._entityRestClient.entityRequest(typeRef, method, listId, id, entity, queryParameter, extraHeaders)
			} else if (!id && queryParameter && queryParameter["ids"]) {
				// load multiple entities
				// TODO: load multiple is not used yet. implement providing from cache when used
				return this._entityRestClient.entityRequest(typeRef, method, listId, id, entity, queryParameter, extraHeaders)
				           .each(entity => {
					           this._putIntoCache(entity)
				           })
			} else if (listId && !id && queryParameter && queryParameter["start"] !== null && queryParameter["start"]
				!== undefined && queryParameter["count"] !== null && queryParameter["count"] !== undefined
				&& queryParameter["reverse"]) { // check for null and undefined because "" and 0 are als falsy
				// load range
				return resolveTypeReference(typeRef).then(typeModel => {
					if (typeModel.values["_id"].type === ValueType.GeneratedId) {
						let params = neverNull(queryParameter)
						return this._loadRange(downcast(typeRef), neverNull(listId), params["start"], Number(params["count"]), params["reverse"]
							=== "true")
					} else {
						// we currently only store ranges for generated ids
						return this._entityRestClient.entityRequest(typeRef, method, listId, id, entity, queryParameter, extraHeaders)
					}
				})
			} else if (id) {
				// load single entity
				if (this._isInCache(typeRef, listId, id)) {
					return Promise.resolve(this._getFromCache(typeRef, listId, id))
				} else {
					return this._entityRestClient.entityRequest(typeRef, method, listId, id, entity, queryParameter, extraHeaders)
					           .then(entity => {
						           this._putIntoCache(entity)
						           return entity
					           })
				}
			} else {
				throw new Error("invalid request params: " + String(listId) + ", " + String(id) + ", "
					+ JSON.stringify(queryParameter))
			}
		} else {
			return this._entityRestClient.entityRequest(typeRef, method, listId, id, entity, queryParameter, extraHeaders)
		}
	}

	_loadRange<T: ListElement>(typeRef: TypeRef<T>, listId: Id, start: Id, count: number, reverse: boolean): Promise<T[]> {
		let path = typeRefToPath(typeRef)
		let listCache = (this._listEntities[path]
			&& this._listEntities[path][listId]) ? this._listEntities[path][listId] : null
		// check which range must be loaded from server
		if (!listCache || (start === GENERATED_MAX_ID && reverse && listCache.upperRangeId !== GENERATED_MAX_ID)
			|| (start === GENERATED_MIN_ID && !reverse && listCache.lowerRangeId !== GENERATED_MIN_ID)) {
			// this is the first request for this list or
			// our upper range id is not MAX_ID and we now read the range starting with MAX_ID. we just replace the complete existing range with the new one because we do not want to handle multiple ranges or
			// our lower range id is not MIN_ID and we now read the range starting with MIN_ID. we just replace the complete existing range with the new one because we do not want to handle multiple ranges
			// this can also happen if we just have read a single element before, so the range is only that element and can be skipped
			return this._entityRestClient.entityRequest(typeRef, HttpMethod.GET, listId, null, null, {
				start: start,
				count: String(count),
				reverse: String(reverse)
			}).then(result => {
				let entities = ((result: any): T[])
				// create the list data path in the cache if not existing
				if (!listCache) {
					if (!this._listEntities[path]) {
						this._listEntities[path] = {}
					}
					listCache = {allRange: [], lowerRangeId: start, upperRangeId: start, elements: {}}
					this._listEntities[path][listId] = listCache
				} else {
					listCache.allRange = []
					listCache.lowerRangeId = start
					listCache.upperRangeId = start
				}
				return this._handleElementRangeResult(listCache, start, count, reverse, entities, count)
			})
		} else if (!firstBiggerThanSecond(start, listCache.upperRangeId)
			&& !firstBiggerThanSecond(listCache.lowerRangeId, start)) { // check if the requested start element is located in the range
			// count the numbers of elements that are already in allRange to determine the number of elements to read
			let newRequestParams = this._getNumberOfElementsToRead(listCache, start, count, reverse)
			if (newRequestParams.newCount > 0) {
				return this._entityRestClient.entityRequest(typeRef, HttpMethod.GET, listId, null, null, {
					start: newRequestParams.newStart,
					count: String(newRequestParams.newCount),
					reverse: String(reverse)
				}).then(entities => {
					return this._handleElementRangeResult(neverNull(listCache), start, count, reverse, ((entities: any): T[]), newRequestParams.newCount)
				})
			} else {
				// all elements are located in the cache.
				return Promise.resolve(this._provideFromCache(listCache, start, count, reverse))
			}
		} else if ((firstBiggerThanSecond(start, listCache.upperRangeId) && !reverse)
			|| (firstBiggerThanSecond(listCache.lowerRangeId, start) && reverse)) {
			let loadStartId
			if (firstBiggerThanSecond(start, listCache.upperRangeId) && !reverse) {
				// start is higher than range. load from upper range id with same count. then, if all available elements have been loaded or the requested number is in cache, return from cache. otherwise load again the same way.
				loadStartId = listCache.upperRangeId
			} else {
				// start is lower than range. load from lower range id with same count. then, if all available elements have been loaded or the requested number is in cache, return from cache. otherwise load again the same way.
				loadStartId = listCache.lowerRangeId
			}
			return this._entityRestClient.entityRequest(typeRef, HttpMethod.GET, listId, null, null, {
				start: loadStartId,
				count: String(count),
				reverse: String(reverse)
			}).then(entities => {
				// put the new elements into the cache
				this._handleElementRangeResult(neverNull(listCache), loadStartId, count, reverse, ((entities: any): T[]), count)
				// provide from cache with the actual start id
				let resultElements = this._provideFromCache(neverNull(listCache), start, count, reverse)
				if (((entities: any): T[]).length < count || resultElements.length === count) {
					// either all available elements have been loaded from target or the requested number of elements could be provided from cache
					return resultElements
				} else {
					// try again with the new elements in the cache
					return this.entityRequest(typeRef, HttpMethod.GET, listId, null, null, {
						start: start,
						count: String(count),
						reverse: String(reverse)
					})
				}
			})
		} else {
			let msg = "invalid range request. path: " + path + " list: " + listId + " start: " + start + " count: "
				+ count + " reverse: " + String(reverse) + " lower: " + listCache.lowerRangeId + " upper: "
				+ listCache.upperRangeId
			return Promise.reject(new Error(msg))
		}
	}

	_handleElementRangeResult<T: ListElement>(listCache: {allRange: Id[], lowerRangeId: Id, upperRangeId: Id, elements: {[key: Id]: Object}}, start: Id, count: number, reverse: boolean, elements: T[], targetCount: number): T[] {
		let elementsToAdd = elements
		if (elements.length > 0) {
			// Ensure that elements are cached in ascending (not reverse) order
			if (reverse) {
				elementsToAdd = elements.reverse()
				if (elements.length < targetCount) {
					listCache.lowerRangeId = GENERATED_MIN_ID
				} else {
					// After reversing the list the first element in the list is the lower range limit
					listCache.lowerRangeId = getLetId(elements[0])[1]
				}
			} else {
				// Last element in the list is the upper range limit
				if (elements.length < targetCount) {
					// all elements have been loaded, so the upper range must be set to MAX_ID
					listCache.upperRangeId = GENERATED_MAX_ID
				} else {
					listCache.upperRangeId = getLetId(elements[elements.length - 1])[1]
				}
			}
			for (let i = 0; i < elementsToAdd.length; i++) {
				this._putIntoCache(elementsToAdd[i])
			}
		} else {
			// all elements have been loaded, so the range must be set to MAX_ID / MIN_ID
			if (reverse) {
				listCache.lowerRangeId = GENERATED_MIN_ID
			} else {
				listCache.upperRangeId = GENERATED_MAX_ID
			}
		}
		return this._provideFromCache(listCache, start, count, reverse)
	}

	/**
	 * Calculates the new start value for the getElementRange request and the number of elements to read in
	 * order to read no duplicate values.
	 * @return returns the new start and count value.
	 */
	_getNumberOfElementsToRead<T>(listCache: {allRange: Id[], lowerRangeId: Id, upperRangeId: Id, elements: {[key: Id]: Object}}, start: Id, count: number, reverse: boolean): {newStart: string, newCount: number} {
		let allRangeList = listCache['allRange']
		let elementsToRead = count
		let startElementId = start

		let indexOfStart = allRangeList.indexOf(start)
		if ((!reverse && listCache.upperRangeId === GENERATED_MAX_ID) || (reverse && listCache.lowerRangeId
			=== GENERATED_MIN_ID)) {
			// we have already loaded the complete range in the desired direction, so we do not have to load from server
			elementsToRead = 0
		} else if (allRangeList.length === 0) { // Element range is empty, so read all elements
			elementsToRead = count
		} else if (indexOfStart !== -1) { // Start element is located in allRange read only elements that are not in allRange.
			if (reverse) {
				elementsToRead = count - indexOfStart
				startElementId = allRangeList[0] // use the lowest id in allRange as start element
			} else {
				elementsToRead = count - (allRangeList.length - 1 - indexOfStart)
				startElementId = allRangeList[allRangeList.length - 1] // use the  highest id in allRange as start element
			}
		} else if (listCache["lowerRangeId"] === start || (firstBiggerThanSecond(start, listCache["lowerRangeId"])
			&& (firstBiggerThanSecond(allRangeList[0], start)))) { // Start element is not in allRange but has been used has start element for a range request, eg. EntityRestInterface.GENERATED_MIN_ID, or start is between lower range id and lowest element in range
			if (!reverse) { // if not reverse read only elements that are not in allRange
				startElementId = allRangeList[allRangeList.length - 1] // use the  highest id in allRange as start element
				elementsToRead = count - allRangeList.length
			}
			// if reverse read all elements
		} else if (listCache["upperRangeId"] === start
			|| (firstBiggerThanSecond(start, allRangeList[allRangeList.length - 1])
				&& (firstBiggerThanSecond(listCache["upperRangeId"], start)))) { // Start element is not in allRange but has been used has start element for a range request, eg. EntityRestInterface.GENERATED_MAX_ID, or start is between upper range id and highest element in range
			if (reverse) { // if not reverse read only elements that are not in allRange
				startElementId = allRangeList[0] // use the  highest id in allRange as start element
				elementsToRead = count - allRangeList.length
			}
			// if not reverse read all elements
		}
		return {newStart: startElementId, newCount: elementsToRead}
	}

	_provideFromCache<T>(listCache: {allRange: Id[], lowerRangeId: Id, upperRangeId: Id, elements: {[key: Id]: Object}}, start: Id, count: number, reverse: boolean): T[] {
		let range = listCache.allRange
		let ids: Id[] = []
		if (reverse) {
			let i
			for (i = range.length - 1; i >= 0; i--) {
				if (firstBiggerThanSecond(start, range[i])) {
					break
				}
			}
			if (i >= 0) {
				let startIndex = i + 1 - count
				if (startIndex < 0) { // start index may be negative if more elements have been requested than available when getting elements reverse.
					startIndex = 0
				}
				ids = range.slice(startIndex, i + 1)
				ids.reverse()
			} else {
				ids = []
			}
		} else {
			let i
			for (i = 0; i < range.length; i++) {
				if (firstBiggerThanSecond(range[i], start)) {
					break
				}
			}
			ids = range.slice(i, i + count)
		}
		let result: T[] = []
		for (let a = 0; a < ids.length; a++) {
			result.push(clone((listCache.elements[ids[a]]: any)))
		}
		return result
	}

	/**
	 * Resolves when the entity is loaded from the server if necessary
	 * @pre The last call of this function must be resolved. This is needed to avoid that e.g. while
	 * loading a created instance from the server we receive an update of that instance and ignore it because the instance is not in the cache yet.
	 */
	entityEventReceived(data: EntityUpdate): Promise<void> {
		if (data.application !== "monitor") {
			let typeRef = new TypeRef(data.application, data.type)
			if (data.operation === OperationType.UPDATE) {
				if (this._isInCache(typeRef, data.instanceListId, data.instanceId)) {
					return this._entityRestClient.entityRequest(typeRef, HttpMethod.GET, data.instanceListId, data.instanceId)
					           .then(entity => {
						           this._putIntoCache(entity)
					           })
				}
			} else if (data.operation === OperationType.DELETE) {
				this._tryRemoveFromCache(typeRef, data.instanceListId, data.instanceId)
			} else if (data.operation === OperationType.CREATE) {
				if (data.instanceListId && this._isInCacheRange(typeRef, data.instanceListId, data.instanceId)) {
					return this._entityRestClient.entityRequest(typeRef, HttpMethod.GET, data.instanceListId, data.instanceId)
					           .then(entity => {
						           this._putIntoCache(entity)
					           })
				}
			}
		}
		return Promise.resolve()
	}

	_isInCache(typeRef: TypeRef<any>, listId: ?Id, id: Id): boolean {
		let path = typeRefToPath(typeRef)
		if (listId) {
			return (this._listEntities[path] != null && this._listEntities[path][listId] != null
				&& this._listEntities[path][listId].elements[id] != null)
		} else {
			return (this._entities[path] != null && this._entities[path][id] != null)
		}
	}

	_getFromCache(typeRef: TypeRef<any>, listId: ?Id, id: Id): any {
		let path = typeRefToPath(typeRef)
		if (listId) {
			return clone(this._listEntities[path][listId].elements[id])
		} else {
			return clone(this._entities[path][id])
		}
	}

	_isInCacheRange(typeRef: TypeRef<any>, listId: Id, id: Id): boolean {
		let path = typeRefToPath(typeRef)
		return (this._listEntities[path] != null && this._listEntities[path][listId] != null
			&& firstBiggerThanSecond(this._listEntities[path][listId].upperRangeId, id)
			&& firstBiggerThanSecond(id, this._listEntities[path][listId].lowerRangeId))
	}

	_putIntoCache(originalEntity: any): void {
		let entity = clone(originalEntity)
		let path = typeRefToPath((entity: any)._type)
		if (entity._id instanceof Array) {
			if (!this._listEntities[path]) {
				this._listEntities[path] = {}
			}
			let listId = entity._id[0]
			let id = entity._id[1]
			if (!this._listEntities[path][listId]) {
				// first element in this list
				this._listEntities[path][listId] = {allRange: [id], lowerRangeId: id, upperRangeId: id, elements: {}}
				this._listEntities[path][listId].elements[id] = entity
			} else {
				// if the element already exists in the cache, overwrite it
				// add new element to existing list if necessary
				this._listEntities[path][listId].elements[id] = entity
				if (!firstBiggerThanSecond(id, this._listEntities[path][listId].upperRangeId)
					&& !firstBiggerThanSecond(this._listEntities[path][listId].lowerRangeId, id)) {
					this._insertIntoRange(this._listEntities[path][listId].allRange, id)
				}
			}
		} else {
			if (!this._entities[path]) {
				this._entities[path] = {}
			}
			this._entities[path][entity._id] = entity
		}
	}

	_insertIntoRange(allRange: Array<Id>, elementId: Id) {
		for (let i = 0; i < allRange.length; i++) {
			let rangeElement = allRange[i]
			if (firstBiggerThanSecond(rangeElement, elementId)) {
				allRange.splice(i, 0, elementId)
				return
			}
			if (rangeElement === elementId) {
				return
			}
		}
		allRange.push(elementId)
	}

	_tryRemoveFromCache(typeRef: TypeRef<any>, listId: ?Id, id: Id): void {
		let path = typeRefToPath(typeRef)
		if (this._isInCache(typeRef, listId, id)) {
			if (listId) {
				delete this._listEntities[path][listId].elements[id]
				remove(this._listEntities[path][listId].allRange, id)
			} else {
				delete this._entities[path][id]
			}
		}
	}
}
