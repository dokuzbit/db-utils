import { createPool } from 'mariadb';
import type { Pool, PoolConnection, QueryOptions, SqlError, UpsertResult } from 'mariadb';
import cache from './cache.server';
import { merge, values } from 'lodash-es';


type joinType = 'LEFT' | 'RIGHT' | 'INNER' | 'OUTER' | 'CROSS';
type Where = string | string[] | Record<string, any> | Record<string, any>[];
type WhereParams = any | any[];
interface dbConfig {
	host?: string;
	user?: string;
	password?: string;
	database?: string;
	connectionLimit?: number;
	trace?: boolean;
	insertIdAsNumber?: boolean;
	decimalAsNumber?: boolean;
	namedPlaceholders?: boolean;
	rowsAsArray?: boolean;
	nestTables?: boolean;
	bigIntAsNumber?: boolean;
	dateStrings?: boolean;
}
interface QueryParams {
	command?: 'findFirst' | 'findMany' | 'findAll';
	select?: string | string[];
	from: string | string[];
	join?: string | string[];
	joinType?: joinType[] | joinType;
	where?: Where;
	whereParams?: any | any[];
	order?: string | string[];
	group?: string | string[];
	limit?: number;
	page?: number;
	offset?: number;
	chunk?: number | '?';
	options?: any;
	asArray?: boolean;
}

interface UpdateParams {
	table: string;
	values: Record<string, any>[] | Record<string, any>;
	where: Where;
	whereParams?: WhereParams;
}



/**
 * @class MariaDB
 * 
 * @description MariaDB class for database operations
 * 
 * @example
 * const db = new MariaDB();
 * await db.config({ host: 'localhost', user: 'root', password: 'password', database: 'test' });
 * const result = await db.query('SELECT * FROM users');
 * 
 * @description Fully tested methods with long-term support
 * @method query - Simple query method
 * @method objectUpdate - Update a single or multiple records with an object
 * @method insert - Insert a single or multiple records
 * @method upsert - Insert a single or multiple records with an update
 * @method delete - Delete a single or multiple records
 * 
 */
export class MariaDB {
	private pool: Pool | undefined;
	private dbConfig: dbConfig | undefined;
	private cache: typeof cache = cache;
	constructor() {
	}

	/**
	 * @method config - Configure the database connection
	 * @param {dbConfig} dbConfig - Database configuratio
	 * @param dbConfig.host - Database host
	 * @param dbConfig.user - Database user
	 * @param dbConfig.password - Database password
	 * @param dbConfig.database - Database name
	 * @param dbConfig.connectionLimit - Database connection limit
	 * @param dbConfig.trace - Database trace
	 * 
	 */
	config(dbConfig: dbConfig) {
		this.dbConfig = merge(this.dbConfig, dbConfig);
		this.dbConfig.trace = dbConfig.trace || process.env.NODE_ENV === 'development';
		this.dbConfig.connectionLimit = dbConfig.connectionLimit || 5;
		if (!this.dbConfig || !this.dbConfig.host || !this.dbConfig.database || !this.dbConfig.user || !this.dbConfig.password) throw new Error('database, user and password are required');
		if (!this.pool) this.pool = createPool(this.dbConfig);
	}

	/**
	 * 
	 * @method query - Simple query method
	 * 
	 * @description Supports both named placeholders and positional placeholders depending on type of values
	 * @description If query includes limit 1, the result will be a single object, otherwise it will be an array
	 * 
	 * @param {string | QueryOptions} sql - SQL query
	 * @param {any[] | Record<string, any>} values - Query values
	 * @param {Record<string, any>[]} params - Query parameters
	 * @returns {Promise<T[] || T>} - Query result
	 * 
	 * @example simple with positional placeholders
	 * const result = await db.query('SELECT * FROM users WHERE id = ?', [1]);
	 * 
	 * @example simple with named placeholders
	 * const result = await db.query('SELECT * FROM users WHERE id = :id', { id: 1 });
	 * 
	 * @example object usuage with named placeholders and limit 1
	 * const result = await db.query({ sql: 'SELECT * FROM users WHERE id = :id limit 1', namedPlaceholders: true }, { id: 1 });
	 * @returns {Promise<T>} - Single object NOT array
	 */

	public async query<T>(sql: string | QueryOptions, values?: any[] | Record<string, any>, params: Record<string, any>[] = []): Promise<T[] | T> {
		if (!this.pool) throw new Error('pool is not initialized');
		// Önce string sql ile object sql yapalım, böylece sonra çift kontrole gerek kalmayacak
		if (typeof sql === 'string') sql = { sql: sql, ...params };

		// Eğer values bir obje ise ve sql bir select ise namedPlaceholders'ı true yapalım
		if (sql.sql.toLowerCase().startsWith('select') && values?.constructor === Object) sql = { ...sql, namedPlaceholders: true };
		let result = await this.pool.query(sql, values);
		// Eğer result bir dizi ve tek bir eleman ise ve sql'de limit 1 varsa, o elemanı döndürelim
		if (result.length === 1 && (/\blimit\s+1\b/i.test(sql.sql))) return result[0];
		// if (sql.sql.toLowerCase().includes('limit 1 ') || sql.sql.toLowerCase().endsWith('limit 1')) return result[0]
		if (result.meta) result.meta = this.getColumnDefs(result.meta);
		return result;
	}


	/**
	 * 
	 * @method objectUpdate - Update a single or multiple records with an object
	 * 
	 * @param {string} options.table - Table name
	 * @param {Array<Object>} options.values - Records to update [{field1: value1, field2: value2, ...}, {...}]
	 * @param {string} options.whereField - Optional (default: "id") unique field name to update (e.g: "id")
	 * @returns {Promise<UpsertResult>} - Operation result
	 * 
	 * @example
	 * const result = await db.objectUpdate({ table: 'users', values: [{ id: 1, name: 'John' }] });
	 * 
	 * @example
	 * const result = await db.objectUpdate({ table: 'users', values: [{ id: 1, name: 'John' }, { id: 2, name: 'Jane' }], whereField: 'id' });
	 * 
	 */

	async objectUpdate(options: { table: string; values: Record<string, any>[]; whereField?: string }): Promise<UpsertResult> {
		const { table, values, whereField = 'id' } = options;

		if (!table || !values || !whereField || !Array.isArray(values) || values.length === 0) throw new Error('Invalid parameters: table, values (array) and whereField are required');
		if (values.some(record => whereField in record === false)) throw new Error(`Tüm kayıtlarda '${whereField}' alanı bulunmalıdır`);

		// Check if all records have the same fields (except whereField)
		const firstRecordFields = Object.keys(values[0]).filter(field => field !== whereField);
		const allHaveSameFields = values.every(record => {
			const fields = Object.keys(record).filter(field => field !== whereField);
			return fields.length === firstRecordFields.length &&
				fields.every(field => firstRecordFields.includes(field));
		});

		if (!allHaveSameFields) throw new Error('All records must have the same fields');

		try {
			const fields = firstRecordFields;
			const setClause = fields.map(field => `${field} = ?`).join(', ');
			const query = `UPDATE ${table} SET ${setClause} WHERE ${whereField} = ?`;

			// Prepare parameters
			const batchParams = values.map(record => {
				const whereValue = record[whereField];
				const values = fields.map(field => record[field]);
				return [...values, whereValue];
			});

			// Use own batch method
			return await this.batch(query, batchParams);

		} catch (err) {
			console.error('Batch update error:', err);
			throw err;
		}
	}


	/**
	 * @method insert - Insert a single or multiple records
	 * 
	 * @param {string} table - Table name
	 * @param {Record<string, any> | Record<string, any>[]} values - Records to insert [{field1: value1, field2: value2, ...}, {...}]
	 * @returns {Promise<UpsertResult>} - Operation result
	 * 
	 * @example single record
	 * const result = await db.insert('users', { name: 'John', email: 'john@example.com' });
	 * 
	 * @example multiple records
	 * const result = await db.insert('users', [{ name: 'John', email: 'john@example.com' }, { name: 'Jane', email: 'jane@example.com' }]);
	 * 
	 */

	async insert<T>(table: string, values: Record<string, any> | Record<string, any>[]): Promise<UpsertResult> {
		// Type safety, convert values to Record<string, any>[]
		const valuesArray: Record<string, any>[] = Array.isArray(values) ? values : [values];

		// Check if values array is empty
		if (valuesArray.length === 0) {
			return { affectedRows: 0, insertId: 0, warningStatus: 0 };
		}

		// All records must have the same fields
		const keys = Object.keys(valuesArray[0]);
		const protectedKeys = keys.map(key => this.protectFieldName(key));

		// Create placeholders for each record
		const placeholders = valuesArray.map(() => `(${keys.map(() => '?').join(',')})`).join(',');
		const flatValues = valuesArray.flatMap(v => keys.map(k => v[k]));

		// Create SQL query
		const sql = `INSERT INTO ${table} (${protectedKeys.join(',')}) VALUES ${placeholders}`;
		const result = await this.execute(sql, flatValues);

		return result;
	}


	/**
	 * @method upsert - Insert a single or multiple records with an update
	 * 
	 * @param {string} table - Table name
	 * @param {Record<string, any>} values - Record to insert
	 * @param {Record<string, any>} update - Record to update
	 * @returns {Promise<any>} - Operation result
	 * 
	 * @example single record
	 * const result = await db.upsert('users', { name: 'John', email: 'john@example.com' }, { email: 'john@example.com' });
	 * 
	 * @example multiple records
	 * const result = await db.upsert('users', [{ name: 'John', email: 'john@example.com' }, { name: 'Jane', email: 'jane@example.com' }], { email: 'john@example.com' });
	 * 
	 */

	public async upsert<T>(table: string, values: Record<string, any>, update: Record<string, any>): Promise<any> {
		const keys = Object.keys(values);
		const updateKeys = Object.keys(update);

		// Alan isimlerini koruma uygula
		const protectedKeys = keys.map(key => this.protectFieldName(key));

		const sql = `INSERT INTO ${table} (${protectedKeys.join(',')}) VALUES (${keys
			.map(() => `?`)
			.join(',')}) ON DUPLICATE KEY UPDATE ${updateKeys
				.map((key) => `${this.protectFieldName(key)} = ?`)
				.join(',')}`;
		return await this.query(sql, [...Object.values(values), ...Object.values(update)]);
	}


	/**
	 * @method delete - Delete a single or multiple records
	 * 
	 * @param {string} table - Table name
	 * @param {string} where - Where clause
	 * @param {any[]} params - Query parameters
	 * @returns {Promise<UpsertResult>} - Operation result
	 * 
	 * @example
	 * const result = await db.delete('users', 'id = 1');
	 * 
	 * @example
	 * const result = await db.delete('users', 'id = 1', [1, 2, 3]);
	 */
	async delete<T>(table: string, where: string, params: any[] = []): Promise<UpsertResult> {
		if (!table || !where) throw new Error('table and where is required');
		const sql = `DELETE FROM ${table} WHERE ${where}`;
		return await this.execute(sql, params);
	}



	async update(params: UpdateParams): Promise<UpsertResult> {
		if (!params.where) throw new Error('where is required');
		let { table, values, where, whereParams } = params;
		// Type güvenliği için values'u Record<string, any>[] olarak dönüştürüyoruz
		const valuesArray: Record<string, any>[] = Array.isArray(values) ? values : [values];

		// Boş values dizisi kontrolü
		if (valuesArray.length === 0) {
			throw new Error('values is required');
		}

		// NOTE: whereParams must be built before where
		whereParams = this.buildWhereParams(where, whereParams);
		where = this.buildWhere(where);

		const sql = `UPDATE ${table} SET ${Object.keys(valuesArray[0])
			.map((key) => `${this.protectFieldName(key)} = ?`)
			.join(',')} WHERE ${where}`;

		const placeholders = valuesArray.flatMap(Object.values);
		return await this.query(sql, [...placeholders, ...whereParams]);
	}


	// TODO: implement asArray
	// TODO: chunk & asArray ???
	async select(params: QueryParams): Promise<any> {
		if (!this.pool) return { error: 'pool is not initialized' };
		if (!params) return { error: 'params is required' };
		let { command, from, select = '*', join = [], joinType, where = '1=1', whereParams, order, group, limit, page, offset, chunk, options, asArray = false } = params;
		if (command === undefined) command = limit && limit > 1 ? 'findMany' : 'findFirst';
		if (command === 'findAll' && chunk === undefined) chunk = 0;

		if (typeof select === 'string') select = [select];
		// select alanları için backtick koruma
		select = select.map((item) => {
			// Eğer select ifadesi zaten "as" içeriyorsa, veya özel bir işlem ise koruma uygulamayalım
			if (item.toLowerCase().includes(' as ') || item.includes('(') || item === '*') {
				return item;
			}
			// Alan adını koru
			return this.protectFieldName(item);
		});

		// Create SQL
		let sql = `SELECT ${select.join(', ')} FROM `;

		// from can be string or array
		if (typeof from === 'string') {
			sql += from;
		} else {
			sql += from.join(', ');
		}

		// join can be string or array
		if (join.length > 0) {
			if (typeof join === 'string') join = [join];
			// joinType can be string or array
			if (!joinType) joinType = 'LEFT';
			if (typeof joinType === 'string') joinType = Array(join.length).fill(joinType);
			for (let i = 0; i < join.length; i++) {
				sql += ` ${joinType[i]} JOIN ${join[i]}`;
			}
		}

		// where can be string or array
		if (where) {
			// NOTE: whereParams must be built before where
			whereParams = this.buildWhereParams(where, whereParams);
			where = this.buildWhere(where);
			sql += ` WHERE ${where}`;
		}

		// group can be string or array
		if (group) {
			if (typeof group === 'string') group = [group];
			// Group by alanları için backtick koruma
			group = group.map(item => this.protectFieldName(item));
			sql += ` GROUP BY ${group.join(', ')}`;
		}

		// order can be string or array
		if (order) {
			if (typeof order === 'string') order = [order];
			// Order by alanları için backtick koruma
			// NOT: order by ifadesi "field ASC/DESC" biçiminde olabileceği için hem alan adını koruyoruz
			// hem de ASC/DESC kısmını koruyoruz
			order = order.map(item => {
				const parts = item.trim().split(/\s+/);
				if (parts.length > 1) {
					return `${this.protectFieldName(parts[0])} ${parts.slice(1).join(' ')}`;
				}
				return this.protectFieldName(item);
			});
			sql += ` ORDER BY ${order.join(', ')}`;
		}

		// limit can be number
		if (limit) {
			sql += ` LIMIT ${limit}`;
			// offset can be number
			if (page && page > 1) {
				sql += ` OFFSET ${(page - 1) * limit}`;
			} else if (offset) {
				sql += ` OFFSET ${offset}`;
			}
		}

		// chunk query
		if (chunk !== undefined && chunk !== null) {
			const [start, end, total] = await this.getChunk(sql, chunk);
			// if chunk is '?', just return total rows
			if (chunk === '?') return { total };
			// if chunk not found, return null
			if (start === null || end === null) return { total };
			// if has where, add AND
			if (where) {
				sql += ` AND id BETWEEN ${start} AND ${end}`;
			} else {
				// if has no where, add WHERE
				sql += ` WHERE id BETWEEN ${start} AND ${end}`;
			}
		}

		const result = await this.query(sql, whereParams || [], options || {});
		// findFirst should return first row
		if (command === 'findFirst' && result.length > 0) {
			return asArray ? [result[0]] : result[0];
		}
		return result;
	}

	// TODO: refactor smilar to pagination and itteratable
	private async getChunk(sql: string, chunk: number | '?' = 0): Promise<[number | null, number | null, number | null]> {
		let chunkTable = await cache.get('chunk' + sql)
		if (!chunkTable) {
			chunkTable = []
			const data = await this.query(sql);
			if (data[0].id === undefined) throw new Error('id is required');
			chunkTable.push([data[0].id, data[data.length > 20 ? 20 - 1 : data.length - 1].id])
			for (let i = 20; i < data.length; i += 1000) {
				chunkTable.push([data[i].id, data[i + 1000 - 1 < data.length - 1 ? i + 1000 - 1 : data.length - 1].id])
			}
			cache.set('chunk' + sql, chunkTable);
		}
		if (chunk >= chunkTable.length) return [null, null, chunkTable.length]
		if (chunk === '?') return [null, null, chunkTable.length]
		return [chunkTable[chunk][0], chunkTable[chunk][1], chunkTable.length]
	}








	//---------------------------------------------------------------------------------------------------
	// Yardımcı fonksiyonlar - Private olabilir ama dışarıdan da erişilebilir
	//---------------------------------------------------------------------------------------------------



	public async execute(sql: string | QueryOptions, values?: any, params: Record<string, any>[] = []): Promise<any> {
		if (!this.pool) return { error: 'pool is not initialized' };
		if (params.length > 0 && typeof sql === 'string') sql = { sql: sql, ...params };
		return await this.pool.execute(sql, values);
	}

	public async batch(sql: string | QueryOptions, values?: any[], params: Record<string, any>[] = []): Promise<UpsertResult> {
		if (!this.pool) throw new Error('pool is not initialized');
		if (params.length > 0 && typeof sql === 'string') sql = { sql: sql, ...params };
		const conn = await this.pool.getConnection();
		const result = await conn.batch<UpsertResult>(sql, values);
		conn.release();
		return result;
	}

	// ---------------------------------------------------------------------------------------------------
	// PRIVATE HELPER FUNCTIONS
	// ---------------------------------------------------------------------------------------------------
	private buildWhere(where: Where): string {
		// if where is empty, return 1=1
		if (!where) return '1 = 1';

		// if where is a string, return it as is
		if (typeof where === 'string') return where;

		// if where is an array of strings
		if (Array.isArray(where) && where.length > 0 && typeof where[0] === 'string') {
			return where.join(' AND ');
		}

		// if where is an object, like {name: 'test', age: 10}
		// return "name = 'test' AND age = 10"
		if (typeof where === 'object' && !Array.isArray(where)) {
			return Object.keys(where)
				.map((key) => {
					// Burada alan adı özel bir SQL kelimesi ise, backtick içinde koruyalım
					const safeKey = this.protectFieldName(key);
					return `${safeKey} = ?`;
				})
				.join(' AND ');
		}

		// if where is an array of objects, like [{name: 'test'}, {age: 10}]
		// return "name = 'test' OR age = 10"  - Bu durumda OR kullanıyoruz!
		if (Array.isArray(where) && where.length > 0 && typeof where[0] === 'object') {
			return where
				.map((obj) => {
					if (!obj) return '';
					return '(' + Object.keys(obj)
						.map((key) => {
							// Burada alan adı özel bir SQL kelimesi ise, backtick içinde koruyalım
							const safeKey = this.protectFieldName(key);
							return `${safeKey} = ?`;
						})
						.join(' AND ') + ')';
				})
				.filter(Boolean)
				.join(' OR '); // Burada OR kullanıyoruz, çünkü farklı koşullar arasında OR bağlacı mantıklı
		}

		return String(where);
	}

	private buildWhereParams(where: Where, whereParams: WhereParams): any[] {
		if (!where) return [];

		// Eğer whereParams belirtilmişse, doğrudan onları kullan
		if (whereParams !== undefined) {
			return Array.isArray(whereParams) ? whereParams : [whereParams];
		}

		// Eğer where bir obje ise (ejson sorgu formatı), değerleri whereParams olarak kullan
		if (typeof where === 'object' && !Array.isArray(where)) {
			return Object.values(where);
		}

		// Eğer where bir obje dizisi ise, tüm değerleri birleştir
		if (Array.isArray(where) && where.length > 0 && typeof where[0] === 'object') {
			return where.flatMap(obj => {
				if (!obj) return [];
				return Object.values(obj);
			});
		}

		return [];
	}

	private sanitizeSql(sql: string): string {
		return sql.replace(/,/g, '`');
	}






	async getJsonValue(table: string, where: string, jsonField: string, path: string = '*') {
		const sql = `SELECT JSON_VALUE(${jsonField}, ?) as value FROM ${table} WHERE ${where} LIMIT 1`;
		return await this.query(sql, [`$.${path}`]);
	}

	async getJsonExtract(table: string, where: string, jsonField: string, path: string = '') {
		const sql = `SELECT JSON_EXTRACT(${jsonField}, ?) as value FROM ${table} WHERE ${where} LIMIT 1`;
		return (await this.query(sql, [path ? `$.${path}` : '$']))[0]?.value;
	}

	async setJsonValue(table: string, where: string, jsonField: string, path: string, value: any) {
		if (!where) throw new Error('where is required');
		const sql = `UPDATE ${table} SET ${jsonField} = JSON_SET(${jsonField}, ?, ?) WHERE ${where}`;
		return await this.query(sql, [`$.${path}`, value]);
	}
	async setJsonObject(table: string, where: string, jsonField: string, path: string, value: Record<string, any>) {
		if (!where) throw new Error('where is required');
		let flattenedValues: any;
		if (Array.isArray(value)) {
			flattenedValues = value.flat();
			const sql = `UPDATE ${table} SET ${jsonField} = JSON_SET(${jsonField}, ?, JSON_ARRAY(${flattenedValues})) WHERE ${where}`;
			return await this.query(sql, [`$.${path}`, ...flattenedValues]);
		} else {
			flattenedValues = Object.entries(value).flat();
			const sql = `UPDATE ${table} SET ${jsonField} = JSON_SET(${jsonField}, ?, JSON_OBJECT(${Array(flattenedValues.length / 2)
				.fill('?,?')
				.join(',')})) WHERE ${where}`;
			return await this.query(sql, [`$.${path}`, ...flattenedValues]);
		}
	}

	async findJsonValue(table: string, where: string, jsonField: string, path: string, value: any) {
		if (!where) where = '1=1';
		const sql = `SELECT * FROM ${table} WHERE ${where} AND JSON_VALUE(${jsonField}, ?) = ?`;
		return await this.query(sql, [`$.${path}`, value]);
	}

	async beginTransaction(): Promise<void> {
		if (!this.pool) throw new Error('Pool is not initialized');
		await this.pool.query('BEGIN');
	}

	async commit(): Promise<void> {
		if (!this.pool) throw new Error('Pool is not initialized');
		await this.pool.query('COMMIT');
	}

	async rollback(): Promise<void> {
		if (!this.pool) throw new Error('Pool is not initialized');
		await this.pool.query('ROLLBACK');
	}



	async close(): Promise<void> {
		if (this.pool) await this.pool.end();
	}

	private getColumnDefs(meta: any[]): any[] {
		if (!meta) return [];
		return meta.map(column => {
			return {
				field: column.name(),
				type: column.type,
			};
		});
	}

	// Özel alan adlarını koruyan yardımcı fonksiyon
	private protectFieldName(fieldName: string): string {
		// rezerve edilmiş SQL kelimelerini kontrol et
		const reservedWords = [
			'not', 'order', 'group', 'limit', 'offset', 'by', 'where', 'from', 'select',
			'update', 'delete', 'add', 'alter', 'column', 'table', 'into', 'set', 'values',
			'as', 'and', 'or', 'join', 'on', 'having', 'case', 'when', 'then', 'else', 'end',
			'like', 'in', 'between', 'is', 'null', 'asc', 'desc', 'distinct', 'all', 'exists',
			'any', 'some', 'inner', 'outer', 'left', 'right', 'full', 'cross', 'using', 'natural'
		];

		// Backtick kontrolü: Eğer alan adı zaten backtick içindeyse dokunma
		if (fieldName.startsWith('`') && fieldName.endsWith('`')) {
			return fieldName;
		}

		// Eğer alan adı tablonun bir parçasıysa (örn: "table.field") 
		// veya nokta içeriyorsa her bir parçayı ayrı ayrı koru
		if (fieldName.includes('.')) {
			const parts = fieldName.split('.');
			return parts.map(part => this.protectFieldName(part)).join('.');
		}

		// Rezerve kelimeler listesinde varsa veya özel karakterler içeriyorsa backtick içine al
		if (reservedWords.includes(fieldName.toLowerCase()) || /[^a-zA-Z0-9_]/.test(fieldName)) {
			return `\`${fieldName}\``;
		}

		return fieldName;
	}

}
export const mariadb = new MariaDB();
export default mariadb;