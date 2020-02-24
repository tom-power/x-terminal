/** @babel */
/*
 * Copyright 2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * Copyright 2017-2018 Andres Mejia <amejia004@gmail.com>. All Rights Reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { Emitter } from 'atom'

import { configDefaults, CONFIG_KEYS_TO_PROFILE, CONFIG_DATA } from './config'

import fs from 'fs-extra'
import path from 'path'

import uuidv4 from 'uuid/v4'
import { URL } from 'whatwg-url'
import { detailedDiff } from 'deep-object-diff'

const X_TERMINAL_BASE_URI = 'x-terminal://'

const XTerminalProfilesSingletonSymbol = Symbol('XTerminalProfilesSingleton sentinel')

class XTerminalProfilesSingleton {
	constructor (symbolCheck) {
		if (XTerminalProfilesSingletonSymbol !== symbolCheck) {
			throw new Error('XTerminalProfilesSingleton cannot be instantiated directly.')
		}
		this.emitter = new Emitter()
		this.profilesConfigPath = path.join(configDefaults.userDataPath, 'profiles.json')
		this.profiles = {}
		this.previousBaseProfile = null
		this.baseProfile = this.getDefaultProfile()
		this.resetBaseProfile()
		this.profilesLoadPromise = null
		this.reloadProfiles()
	}

	static get instance () {
		if (!this[XTerminalProfilesSingletonSymbol]) {
			this[XTerminalProfilesSingletonSymbol] = new XTerminalProfilesSingleton(XTerminalProfilesSingletonSymbol)
		}
		return this[XTerminalProfilesSingletonSymbol]
	}

	sortProfiles (profiles) {
		const orderedProfiles = {}
		Object.keys(profiles).sort().forEach((key) => {
			orderedProfiles[key] = profiles[key]
		})
		return orderedProfiles
	}

	async reloadProfiles () {
		let resolveLoad
		this.profilesLoadPromise = new Promise((resolve) => {
			resolveLoad = resolve
		})
		try {
			const data = await fs.readJson(this.profilesConfigPath)
			this.profiles = this.sortProfiles(data)
			this.emitter.emit('did-reload-profiles', this.getSanitizedProfilesData())
			resolveLoad()
		} catch (err) {
			// Create the profiles file.
			await this.updateProfiles({})
			this.emitter.emit('did-reload-profiles', this.getSanitizedProfilesData())
			resolveLoad()
		}
	}

	onDidReloadProfiles (callback) {
		return this.emitter.on('did-reload-profiles', callback)
	}

	onDidResetBaseProfile (callback) {
		return this.emitter.on('did-reset-base-profile', callback)
	}

	async updateProfiles (newProfilesConfigData) {
		await fs.ensureDir(path.dirname(this.profilesConfigPath))
		newProfilesConfigData = this.sortProfiles(newProfilesConfigData)
		await fs.writeJson(this.profilesConfigPath, newProfilesConfigData)
		this.profiles = newProfilesConfigData
	}

	deepClone (data) {
		return JSON.parse(JSON.stringify(data))
	}

	diffProfiles (oldProfile, newProfile) {
		// This method will return added or modified entries.
		const diff = detailedDiff(oldProfile, newProfile)
		return Object.assign(diff.added, diff.updated)
	}

	getDefaultProfile () {
		return CONFIG_DATA.reduce((o, data) => {
			if (data.inProfile) {
				o[data.profileKey] = data.defaultProfile
			}
			return o
		}, {})
	}

	getBaseProfile () {
		return this.deepClone(this.baseProfile)
	}

	resetBaseProfile () {
		this.previousBaseProfile = this.deepClone(this.baseProfile)
		this.baseProfile = CONFIG_DATA.reduce((o, data) => {
			if (data.inProfile) {
				o[data.profileKey] = data.toBaseProfile(this.previousBaseProfile[data.profileKey])
			}
			return o
		}, {})
		this.emitter.emit('did-reset-base-profile', this.getBaseProfile())
	}

	sanitizeData (data) {
		const sanitizedData = Object.values(CONFIG_KEYS_TO_PROFILE).reduce((p, v) => {
			if (v in data)p[v] = data[v]
			return p
		}, {})

		return this.deepClone(sanitizedData)
	}

	getSanitizedProfilesData () {
		const retval = {}
		for (const key in this.profiles) {
			retval[key] = this.sanitizeData(this.profiles[key])
		}
		return retval
	}

	async getProfiles () {
		await this.profilesLoadPromise
		return this.getSanitizedProfilesData()
	}

	async getProfile (profileName) {
		await this.profilesLoadPromise
		return {
			...this.deepClone(this.baseProfile),
			...this.sanitizeData(this.profiles[profileName] || {}),
		}
	}

	async isProfileExists (profileName) {
		await this.profilesLoadPromise
		return profileName in this.profiles
	}

	async setProfile (profileName, data) {
		await this.profilesLoadPromise
		const profileData = {
			...this.deepClone(this.baseProfile),
			...this.sanitizeData(data),
		}
		const newProfilesConfigData = {
			...this.deepClone(this.profiles),
		}
		newProfilesConfigData[profileName] = profileData
		await this.updateProfiles(newProfilesConfigData)
	}

	async deleteProfile (profileName) {
		await this.profilesLoadPromise
		const newProfilesConfigData = {
			...this.deepClone(this.profiles),
		}
		delete newProfilesConfigData[profileName]
		await this.updateProfiles(newProfilesConfigData)
	}

	generateNewUri () {
		return X_TERMINAL_BASE_URI + uuidv4() + '/'
	}

	generateNewUrlFromProfileData (data) {
		data = this.sanitizeData(data)
		const url = new URL(this.generateNewUri())
		for (const configData of CONFIG_DATA) {
			if (configData.inProfile) {
				const toUrlParam = configData.toUrlParam || (v => v)
				if (configData.profileKey in data) url.searchParams.set(configData.profileKey, toUrlParam(data[configData.profileKey]))
			}
		}
		return url
	}

	createProfileDataFromUri (uri) {
		const url = new URL(uri)
		const baseProfile = this.getBaseProfile()
		return CONFIG_DATA.reduce((o, data) => {
			if (data.inProfile) {
				const fromUrlParam = data.fromUrlParam || (v => v)
				const checkUrlParam = data.checkUrlParam || (v => true)
				const param = url.searchParams.get(data.profileKey)
				if (param) {
					o[data.profileKey] = fromUrlParam(param)
				}
				if (!param || !checkUrlParam(o[data.profileKey])) {
					o[data.profileKey] = baseProfile[data.profileKey]
				}
			}
			return o
		}, {})
	}
}

export {
	X_TERMINAL_BASE_URI,
	XTerminalProfilesSingleton,
}
