(function(root, factory) {

	if (typeof exports !== 'undefined') {
		// Define as CommonJS export:
		module.exports = factory(require("underscore"), require("backbone"));
	} else if (typeof define === 'function' && define.amd) {
		// Define as AMD:
		define(["underscore", "backbone"], factory);
	} else {
		// Just run it:
		factory(root._, root.Backbone);
	}

}(this, function(_, Backbone) {

	var extend = function(protoProps, staticProps) {
		var parent = this;
		var child;

		// The constructor function for the new subclass is either defined by you
		// (the "constructor" property in your `extend` definition), or defaulted
		// by us to simply call the parent constructor.
		if (protoProps && _.has(protoProps, 'constructor')) {
			child = protoProps.constructor;
		} else {
			child = function(){ return parent.apply(this, arguments); };
		}

		// Add static properties to the constructor function, if supplied.
		_.extend(child, parent, staticProps);

		// Set the prototype chain to inherit from `parent`, without calling
		// `parent` constructor function.
		var Surrogate = function(){ this.constructor = child; };
		Surrogate.prototype = parent.prototype;
		child.prototype = new Surrogate;

		// Add prototype properties (instance properties) to the subclass,
		// if supplied.
		if (protoProps) _.extend(child.prototype, protoProps);

		// Set a convenience property in case the parent's prototype is needed
		// later.
		child.__super__ = parent.prototype;

		return child;
	};



	// Gonrin namespace:
	var Gonrin = Backbone.Gonrin = {};

	// Object-type utils:
	var array = Array.prototype;
	var isUndefined = _.isUndefined;
	var isFunction = _.isFunction;
	var isObject = _.isObject;
	var isArray = _.isArray;
	var isModel = function(obj) { return obj instanceof Backbone.Model; };
	var isCollection = function(obj) { return obj instanceof Backbone.Collection; };
	var blankMethod = function() {};

	// Static mixins API:
	// added as a static member to Gonrin class objects (Model & View);
	// generates a set of class attributes for mixin with other objects.
	var mixins = {
			mixin: function(extend) {
				extend = extend || {};

				for (var i in this.prototype) {
					// Skip override on pre-defined binding declarations:
					if (i === 'bindings' && extend.bindings) continue;

					// Assimilate non-constructor Gonrin prototype properties onto extended object:
					if (this.prototype.hasOwnProperty(i) && i !== 'constructor') {
						extend[i] = this.prototype[i];
					}
				}
				return extend;
			}
	};

	// Calls method implementations of a super-class object:
	function _super(instance, method, args) {
		return instance._super.prototype[method].apply(instance, args);
	}

	var modelMap;
	var modelProps = ['computeds'];

	Gonrin.Model = Backbone.Model.extend({
		_super: Backbone.Model,

		// Backbone.Model constructor override:
		// configures computed model attributes around the underlying native Backbone model.
		constructor: function(attributes, options) {
			_.extend(this, _.pick(options||{}, modelProps));
			//this.initSchema();
			_super(this, 'constructor', arguments);
			this.initComputeds(attributes, options);
		},

		// Gets a copy of a model attribute value:
		// Array and Object values will return a shallow copy,
		// primitive values will be returned directly.
		getCopy: function(attribute) {
			return _.clone(this.get(attribute));
		},

		// Backbone.Model.get() override:
		// provides access to computed attributes,
		// and maps computed dependency references while establishing bindings.
		get: function(attribute) {

			// Automatically register bindings while building out computed dependency graphs:
			modelMap && modelMap.push(['change:'+attribute, this]);

			// Return a computed property value, if available:
			if (this.hasComputed(attribute)) {
				return this.c()[ attribute ].get();
			}

			// Default to native Backbone.Model get operation:
			return _super(this, 'get', arguments);
		},

		// Backbone.Model.set() override:
		// will process any computed attribute setters,
		// and then pass along all results to the underlying model.
		set: function(key, value, options) {
			var params = key;

			// Convert key/value arguments into {key:value} format:
			if (params && !isObject(params)) {
				params = {};
				params[ key ] = value;
			} else {
				options = value;
			}

			// Default options definition:
			options = options || {};

			// Create store for capturing computed change events:
			var computedEvents = this._setting = [];

			// Attempt to set computed attributes while not unsetting:
			if (!options.unset) {
				// All param properties are tested against computed setters,
				// properties set to computeds will be removed from the params table.
				// Optionally, an computed setter may return key/value pairs to be merged into the set.
				params = deepModelSet(this, params, {}, []);
			}

			// Remove computed change events store:
			delete this._setting;

			// Pass all resulting set params along to the underlying Backbone Model.
			var result = _super(this, 'set', [params, options]);

			// Dispatch all outstanding computed events:
			if (!options.silent) {
				// Make sure computeds get a "change" event:
				if (!this.hasChanged() && computedEvents.length) {
					this.trigger('change', this);
				}

				// Trigger each individual computed attribute change:
				// NOTE: computeds now officially fire AFTER basic "change"...
				// We can't really fire them earlier without duplicating the Backbone "set" method here.
				_.each(computedEvents, function(evt) {
					this.trigger.apply(this, evt);
				}, this);
			}
			return result;
		},

		// Backbone.Model.toJSON() override:
		// adds a 'computed' option, specifying to include computed attributes.
		toJSON: function(options) {
			var json = _super(this, 'toJSON', arguments);

			if (options && options.computed) {
				_.each(this.c(), function(computed, attribute) {
					json[ attribute ] = computed.value;
				});
			}

			return json;
		},

		// Backbone.Model.destroy() override:
		// clears all computed attributes before destroying.
		destroy: function() {
			this.clearComputeds();
			return _super(this, 'destroy', arguments);
		},

		// Computed namespace manager:
		// Allows the model to operate as a mixin.
		c: function() {
			return this._c || (this._c = {});
		},

		// Initializes the Gonrin model:
		// called automatically by the native constructor,
		// or may be called manually when adding Gonrin as a mixin.
		initComputeds: function(attributes, options) {
			this.clearComputeds();

			// Resolve computeds hash, and extend it with any preset attribute keys:
			// TODO: write test.
			var computeds = _.result(this, 'computeds')||{};
			computeds = _.extend(computeds, _.pick(attributes||{}, _.keys(computeds)));

			// Add all computed attributes:
			_.each(computeds, function(params, attribute) {
				params._init = 1;
				this.addComputed(attribute, params);
			}, this);

			// Initialize all computed attributes:
			// all presets have been constructed and may reference each other now.
			_.invoke(this.c(), 'init');
		},

		// Adds a computed attribute to the model:
		// computed attribute will assemble and return customized values.
		// @param attribute (string)
		// @param getter (function) OR params (object)
		// @param [setter (function)]
		// @param [dependencies ...]
		addComputed: function(attribute, getter, setter) {
			this.removeComputed(attribute);

			var params = getter;
			var delayInit = params._init;

			// Test if getter and/or setter are provided:
			if (isFunction(getter)) {
				var depsIndex = 2;

				// Add getter param:
				params = {};
				params._get = getter;

				// Test for setter param:
				if (isFunction(setter)) {
					params._set = setter;
					depsIndex++;
				}

				// Collect all additional arguments as dependency definitions:
				params.deps = array.slice.call(arguments, depsIndex);
			}

			// Create a new computed attribute:
			this.c()[ attribute ] = new GonrinComputedModel(this, attribute, params, delayInit);
			return this;
		},

		// Tests the model for a computed attribute definition:
		hasComputed: function(attribute) {
			return this.c().hasOwnProperty(attribute);
		},

		// Removes an computed attribute from the model:
		removeComputed: function(attribute) {
			if (this.hasComputed(attribute)) {
				this.c()[ attribute ].dispose();
				delete this.c()[ attribute ];
			}
			return this;
		},

		// Removes all computed attributes:
		clearComputeds: function() {
			for (var attribute in this.c()) {
				this.removeComputed(attribute);
			}
			return this;
		},

		// Internal array value modifier:
		// performs array ops on a stored array value, then fires change.
		// No action is taken if the specified attribute value is not an array.
		modifyArray: function(attribute, method, options) {
			var obj = this.get(attribute);

			if (isArray(obj) && isFunction(array[method])) {
				var args = array.slice.call(arguments, 2);
				var result = array[ method ].apply(obj, args);
				options = options || {};

				if (!options.silent) {
					this.trigger('change:'+attribute+' change', this, array, options);
				}
				return result;
			}
			return null;
		},

		// Internal object value modifier:
		// sets new property values on a stored object value, then fires change.
		// No action is taken if the specified attribute value is not an object.
		modifyObject: function(attribute, property, value, options) {
			var obj = this.get(attribute);
			var change = false;

			// If property is Object:
			if (isObject(obj)) {

				options = options || {};

				// Delete existing property in response to undefined values:
				if (isUndefined(value) && obj.hasOwnProperty(property)) {
					delete obj[property];
					change = true;
				}
				// Set new and/or changed property values:
				else if (obj[ property ] !== value) {
					obj[ property ] = value;
					change = true;
				}

				// Trigger model change:
				if (change && !options.silent) {
					this.trigger('change:'+attribute+' change', this, obj, options);
				}

				// Return the modified object:
				return obj;
			}
			return null;
		}
	}, mixins);

	// Gonrin.Model -> Private
	// ----------------------

	// Model deep-setter:
	// Attempts to set a collection of key/value attribute pairs to computed attributes.
	// Observable setters may digest values, and then return mutated key/value pairs for inclusion into the set operation.
	// Values returned from computed setters will be recursively deep-set, allowing computeds to set other computeds.
	// The final collection of resolved key/value pairs (after setting all computeds) will be returned to the native model.
	// @param model: target Gonrin model on which to operate.
	// @param toSet: an object of key/value pairs to attempt to set within the computed model.
	// @param toReturn: resolved non-ovservable attribute values to be returned back to the native model.
	// @param trace: property stack trace (prevents circular setter loops).
	function deepModelSet(model, toSet, toReturn, stack) {

		// Loop through all setter properties:
		for (var attribute in toSet) {
			if (toSet.hasOwnProperty(attribute)) {

				// Pull each setter value:
				var value = toSet[ attribute ];

				if (model.hasComputed(attribute)) {

					// Has a computed attribute:
					// comfirm attribute does not already exist within the stack trace.
					if (!stack.length || !_.contains(stack, attribute)) {

						// Non-recursive:
						// set and collect value from computed attribute.
						value = model.c()[attribute].set(value);

						// Recursively set new values for a returned params object:
						// creates a new copy of the stack trace for each new search branch.
						if (value && isObject(value)) {
							toReturn = deepModelSet(model, value, toReturn, stack.concat(attribute));
						}

					} else {
						// Recursive:
						// Throw circular reference error.
						throw('Recursive setter: '+stack.join(' > '));
					}
				} else {
					// No computed attribute:
					// set the value to the keeper values.
					toReturn[ attribute ] = value;
				}
			}
		}

		return toReturn;
	}


	// Gonrin.Model -> Computed
	// -----------------------
	// Computed objects store model values independently from the model's attributes table.
	// Computeds define custom getter/setter functions to manage their value.

	function GonrinComputedModel(model, name, params, delayInit) {
		params = params || {};

		// Rewrite getter param:
		if (params.get && isFunction(params.get)) {
			params._get = params.get;
		}

		// Rewrite setter param:
		if (params.set && isFunction(params.set)) {
			params._set = params.set;
		}

		// Prohibit override of 'get()' and 'set()', then extend:
		delete params.get;
		delete params.set;
		_.extend(this, params);

		// Set model, name, and default dependencies array:
		this.model = model;
		this.name = name;
		this.deps = this.deps || [];

		// Skip init while parent model is initializing:
		// Model will initialize in two passes...
		// the first pass sets up all computed attributes,
		// then the second pass initializes all bindings.
		if (!delayInit) this.init();
	}

	_.extend(GonrinComputedModel.prototype, Backbone.Events, {

		// Initializes the computed's value and bindings:
		// this method is called independently from the object constructor,
		// allowing computeds to build and initialize in two passes by the parent model.
		init: function() {

			// Configure dependency map, then update the computed's value:
			// All Gonrin.Model attributes accessed while getting the initial value
			// will automatically register themselves within the model bindings map.
			var bindings = {};
			var deps = modelMap = [];
			this.get(true);
			modelMap = null;

			// If the computed has dependencies, then proceed to binding it:
			if (deps.length) {

				// Compile normalized bindings table:
				// Ultimately, we want a table of event types, each with an array of their associated targets:
				// {'change:name':[<model1>], 'change:status':[<model1>,<model2>]}

				// Compile normalized bindings map:
				_.each(deps, function(value) {
					var attribute = value[0];
					var target = value[1];

					// Populate event target arrays:
					if (!bindings[attribute]) {
						bindings[attribute] = [ target ];

					} else if (!_.contains(bindings[attribute], target)) {
						bindings[attribute].push(target);
					}
				});

				// Bind all event declarations to their respective targets:
				_.each(bindings, function(targets, binding) {
					for (var i=0, len=targets.length; i < len; i++) {
						this.listenTo(targets[i], binding, _.bind(this.get, this, true));
					}
				}, this);
			}
		},

		// Gets an attribute value from the parent model.
		val: function(attribute) {
			return this.model.get(attribute);
		},

		// Gets the computed's current value:
		// Computed values flagged as dirty will need to regenerate themselves.
		// Note: 'update' is strongly checked as TRUE to prevent unintended arguments (handler events, etc) from qualifying.
		get: function(update) {
			if (update === true && this._get) {
				var val = this._get.apply(this.model, _.map(this.deps, this.val, this));
				this.change(val);
			}
			return this.value;
		},

		// Sets the computed's current value:
		// computed values (have a custom getter method) require a custom setter.
		// Custom setters should return an object of key/values pairs;
		// key/value pairs returned to the parent model will be merged into its main .set() operation.
		set: function(val) {
			if (this._get) {
				if (this._set) return this._set.apply(this.model, arguments);
				else throw('Cannot set read-only computed attribute.');
			}
			this.change(val);
			return null;
		},

		// Changes the computed's value:
		// new values are cached, then fire an update event.
		change: function(value) {
			if (!_.isEqual(value, this.value)) {
				this.value = value;
				var evt = ['change:'+this.name, this.model, value];

				if (this.model._setting) {
					this.model._setting.push(evt);
				} else {
					evt[0] += ' change';
					this.model.trigger.apply(this.model, evt);
				}
			}
		},

		// Disposal:
		// cleans up events and releases references.
		dispose: function() {
			this.stopListening();
			this.off();
			this.model = this.value = null;
		}
	});


	// Gonrin.binding -> Binding API
	// ----------------------------

	var bindingSettings = {
			optionText: 'label',
			optionValue: 'value'
	};


	// Cache for storing binding parser functions:
	// Cuts down on redundancy when building repetitive binding views.
	var bindingCache = {};


	// Reads value from an accessor:
	// Accessors come in three potential forms:
	// => A function to call for the requested value.
	// => An object with a collection of attribute accessors.
	// => A primitive (string, number, boolean, etc).
	// This function unpacks an accessor and returns its underlying value(s).

	function readAccessor(accessor) {

		if (isFunction(accessor)) {
			// Accessor is function: return invoked value.
			return accessor();
		}
		else if (isObject(accessor)) {
			// Accessor is object/array: return copy with all attributes read.
			accessor = _.clone(accessor);

			_.each(accessor, function(value, key) {
				accessor[ key ] = readAccessor(value);
			});
		}
		// return formatted value, or pass through primitives:
		return accessor;
	}


	// Binding Handlers
	// ----------------
	// Handlers define set/get methods for exchanging data with the DOM.

	// Formatting function for defining new handler objects:
	function makeHandler(handler) {
		return isFunction(handler) ? {set: handler} : handler;
	}

	var bindingHandlers = {
			// Attribute: write-only. Sets element attributes.
			attr: makeHandler(function($element, value) {
				$element.attr(value);
			}),

			// Checked: read-write. Toggles the checked status of a form element.
			checked: makeHandler({
				get: function($element, currentValue, evt) {
					if ($element.length > 1) {
						$element = $element.filter(evt.target);
					}

					var checked = !!$element.prop('checked');
					var value = $element.val();

					if (this.isRadio($element)) {
						// Radio button: return value directly.
						return value;

					} else if (isArray(currentValue)) {
						// Checkbox array: add/remove value from list.
						currentValue = currentValue.slice();
						var index = _.indexOf(currentValue, value);

						if (checked && index < 0) {
							currentValue.push(value);
						} else if (!checked && index > -1) {
							currentValue.splice(index, 1);
						}
						return currentValue;
					}
					// Checkbox: return boolean toggle.
					return checked;
				},
				set: function($element, value) {
					if ($element.length > 1) {
						$element = $element.filter('[value="'+ value +'"]');
					}

					// Default as loosely-typed boolean:
					var checked = !!value;

					if (this.isRadio($element)) {
						// Radio button: match checked state to radio value.
						checked = (value == $element.val());

					} else if (isArray(value)) {
						// Checkbox array: match checked state to checkbox value in array contents.
						checked = _.contains(value, $element.val());
					}

					// Set checked property to element:
					$element.prop('checked', checked);
				},
				// Is radio button: avoids '.is(":radio");' check for basic Zepto compatibility.
				isRadio: function($element) {
					return $element.attr('type').toLowerCase() === 'radio';
				}
			}),

			// Class Name: write-only. Toggles a collection of class name definitions.
			classes: makeHandler(function($element, value) {
				_.each(value, function(enabled, className) {
					$element.toggleClass(className, !!enabled);
				});
			}),

			// Collection: write-only. Manages a list of views bound to a Backbone.Collection.
			collection: makeHandler({
				init: function($element, collection, context, bindings) {
					this.i = bindings.itemView ? this.view[bindings.itemView] : this.view.itemView;
					if (!isCollection(collection)) throw('Binding "collection" requires a Collection.');
					if (!isFunction(this.i)) throw('Binding "collection" requires an itemView.');
					this.v = {};
				},
				set: function($element, collection, target) {

					var view;
					var views = this.v;
					var ItemView = this.i;
					var models = collection.models;

					// Cache and reset the current dependency graph state:
					// sub-views may be created (each with their own dependency graph),
					// therefore we need to suspend the working graph map here before making children...
					var mapCache = viewMap;
					viewMap = null;

					// Default target to the bound collection object:
					// during init (or failure), the binding will reset.
					target = target || collection;

					if (isModel(target)) {

						// ADD/REMOVE Event (from a Model):
						// test if view exists within the binding...
						if (!views.hasOwnProperty(target.cid)) {

							// Add new view:
							views[ target.cid ] = view = new ItemView({model: target, collectionView: this.view});
							var index = _.indexOf(models, target);
							var $children = $element.children();

							// Attempt to add at proper index,
							// otherwise just append into the element.
							if (index < $children.length) {
								$children.eq(index).before(view.$el);
							} else {
								$element.append(view.$el);
							}

						} else {

							// Remove existing view:
							views[ target.cid ].remove();
							delete views[ target.cid ];
						}

					} else if (isCollection(target)) {

						// SORT/RESET Event (from a Collection):
						// First test if we're sorting...
						// (number of models has not changed and all their views are present)
						var sort = models.length === _.size(views) && collection.every(function(model) {
							return views.hasOwnProperty(model.cid);
						});

						// Hide element before manipulating:
						$element.children().detach();
						var frag = document.createDocumentFragment();

						if (sort) {
							// Sort existing views:
							collection.each(function(model) {
								frag.appendChild(views[model.cid].el);
							});

						} else {
							// Reset with new views:
							this.clean();
							collection.each(function(model) {
								views[ model.cid ] = view = new ItemView({model: model, collectionView: this.view});
								frag.appendChild(view.el);
							}, this);
						}

						$element.append(frag);
					}

					// Restore cached dependency graph configuration:
					viewMap = mapCache;
				},
				clean: function() {
					for (var id in this.v) {
						if (this.v.hasOwnProperty(id)) {
							this.v[ id ].remove();
							delete this.v[ id ];
						}
					}
				}
			}),

			// CSS: write-only. Sets a collection of CSS styles to an element.
			css: makeHandler(function($element, value) {
				$element.css(value);
			}),

			// Disabled: write-only. Sets the 'disabled' status of a form element (true :: disabled).
			disabled: makeHandler(function($element, value) {
				$element.prop('disabled', !!value);
			}),

			// Enabled: write-only. Sets the 'disabled' status of a form element (true :: !disabled).
			enabled: makeHandler(function($element, value) {
				$element.prop('disabled', !value);
			}),

			// HTML: write-only. Sets the inner HTML value of an element.
			html: makeHandler(function($element, value) {
				$element.html(value);
			}),

			// Options: write-only. Sets option items to a <select> element, then updates the value.
			options: makeHandler({
				init: function($element, value, context, bindings) {
					this.e = bindings.optionsEmpty;
					this.d = bindings.optionsDefault;
					this.v = bindings.value;
				},
				set: function($element, value) {

					// Pre-compile empty and default option values:
					// both values MUST be accessed, for two reasons:
					// 1) we need to need to guarentee that both values are reached for mapping purposes.
					// 2) we'll need their values anyway to determine their defined/undefined status.
					var self = this;
					var optionsEmpty = readAccessor(self.e);
					var optionsDefault = readAccessor(self.d);
					var currentValue = readAccessor(self.v);
					var options = isCollection(value) ? value.models : value;
					var numOptions = options.length;
					var enabled = true;
					var html = '';

					// No options or default, and has an empty options placeholder:
					// display placeholder and disable select menu.
					if (!numOptions && !optionsDefault && optionsEmpty) {

						html += self.opt(optionsEmpty, numOptions);
						enabled = false;

					} else {
						// Try to populate default option and options list:

						// Configure list with a default first option, if defined:
						if (optionsDefault) {
							options = [ optionsDefault ].concat(options);
						}

						// Create all option items:
						_.each(options, function(option, index) {
							html += self.opt(option, numOptions);
						});
					}

					// Set new HTML to the element and toggle disabled status:
					$element.html(html).prop('disabled', !enabled).val(currentValue);

					// Pull revised value with new options selection state:
					var revisedValue = $element.val();

					// Test if the current value was successfully applied:
					// if not, set the new selection state into the model.
					if (self.v && !_.isEqual(currentValue, revisedValue)) {
						self.v(revisedValue);
					}
				},
				opt: function(option, numOptions) {
					// Set both label and value as the raw option object by default:
					var label = option;
					var value = option;
					var textAttr = bindingSettings.optionText;
					var valueAttr = bindingSettings.optionValue;

					// Dig deeper into label/value settings for non-primitive values:
					if (isObject(option)) {
						// Extract a label and value from each object:
						// a model's 'get' method is used to access potential computed values.
						label = isModel(option) ? option.get(textAttr) : option[ textAttr ];
						value = isModel(option) ? option.get(valueAttr) : option[ valueAttr ];
					}

					return ['<option value="', value, '">', label, '</option>'].join('');
				},
				clean: function() {
					this.d = this.e = this.v = 0;
				}
			}),

			// Template: write-only. Renders the bound element with an Underscore template.
			template: makeHandler({
				init: function($element, value, context) {
					var raw = $element.find('script,template');
					this.t = _.template(raw.length ? raw.html() : $element.html());

					// If an array of template attributes was provided,
					// then replace array with a compiled hash of attribute accessors:
					if (isArray(value)) {
						return _.pick(context, value);
					}
				},
				set: function($element, value) {
					value = isModel(value) ? value.toJSON({computed:true}) : value;
					$element.html(this.t(value));
				},
				clean: function() {
					this.t = null;
				}
			}),

			// Text: read-write. Gets and sets the text value of an element.
			text: makeHandler({
				get: function($element) {
					return $element.text();
				},
				set: function($element, value) {
					$element.text(value);
				}
			}),

			// Toggle: write-only. Toggles the visibility of an element.
			toggle: makeHandler(function($element, value) {
				$element.toggle(!!value);
			}),

			// Value: read-write. Gets and sets the value of a form element.
			value: makeHandler({
				get: function($element) {
					return $element.val();
				},
				set: function($element, value) {
					try {
						if ($element.val() + '' != value + '') $element.val(value);
					} catch (error) {
						// Error setting value: IGNORE.
						// This occurs in IE6 while attempting to set an undefined multi-select option.
						// unfortuantely, jQuery doesn't gracefully handle this error for us.
						// remove this try/catch block when IE6 is officially deprecated.
					}
				}
			})
	};


	// Binding Filters
	// ---------------
	// Filters are special binding handlers that may be invoked while binding;
	// they will return a wrapper function used to modify how accessors are read.

	// Partial application wrapper for creating binding filters:
	function makeFilter(handler) {
		return function() {
			var params = arguments;
			var read = isFunction(handler) ? handler : handler.get;
			var write = handler.set;
			return function(value) {
				return isUndefined(value) ?
						read.apply(this, _.map(params, readAccessor)) :
							params[0]((write ? write : read).call(this, value));
			};
		};
	}

	var bindingFilters = {
			// Positive collection assessment [read-only]:
			// Tests if all of the provided accessors are truthy (and).
			all: makeFilter(function() {
				var params = arguments;
				for (var i=0, len=params.length; i < len; i++) {
					if (!params[i]) return false;
				}
				return true;
			}),

			// Partial collection assessment [read-only]:
			// tests if any of the provided accessors are truthy (or).
			any: makeFilter(function() {
				var params = arguments;
				for (var i=0, len=params.length; i < len; i++) {
					if (params[i]) return true;
				}
				return false;
			}),

			// Collection length accessor [read-only]:
			// assumes accessor value to be an Array or Collection; defaults to 0.
			length: makeFilter(function(value) {
				return value.length || 0;
			}),

			// Negative collection assessment [read-only]:
			// tests if none of the provided accessors are truthy (and not).
			none: makeFilter(function() {
				var params = arguments;
				for (var i=0, len=params.length; i < len; i++) {
					if (params[i]) return false;
				}
				return true;
			}),

			// Negation [read-only]:
			not: makeFilter(function(value) {
				return !value;
			}),

			// Formats one or more accessors into a text string:
			// ('$1 $2 did $3', firstName, lastName, action)
			format: makeFilter(function(str) {
				var params = arguments;

				for (var i=1, len=params.length; i < len; i++) {
					// TODO: need to make something like this work: (?<!\\)\$1
					str = str.replace(new RegExp('\\$'+i, 'g'), params[i]);
				}
				return str;
			}),

			// Provides one of two values based on a ternary condition:
			// uses first param (a) as condition, and returns either b (truthy) or c (falsey).
			select: makeFilter(function(condition, truthy, falsey) {
				return condition ? truthy : falsey;
			}),

			// CSV array formatting [read-write]:
			csv: makeFilter({
				get: function(value) {
					value = String(value);
					return value ? value.split(',') : [];
				},
				set: function(value) {
					return isArray(value) ? value.join(',') : value;
				}
			}),

			// Integer formatting [read-write]:
			integer: makeFilter(function(value) {
				return value ? parseInt(value, 10) : 0;
			}),

			// Float formatting [read-write]:
			decimal: makeFilter(function(value) {
				return value ? parseFloat(value) : 0;
			})
	};

	// Define allowed binding parameters:
	// These params may be included in binding handlers without throwing errors.
	var allowedParams = {
			events: 1,
			itemView: 1,
			optionsDefault: 1,
			optionsEmpty: 1
	};

	// Define binding API:
	Gonrin.binding = {
			allowedParams: allowedParams,
			addHandler: function(name, handler) {
				bindingHandlers[ name ] = makeHandler(handler);
			},
			addFilter: function(name, handler) {
				bindingFilters[ name ] = makeFilter(handler);
			},
			config: function(settings) {
				_.extend(bindingSettings, settings);
			},
			emptyCache: function() {
				bindingCache = {};
			}
	};


	// Gonrin.View
	// ----------
	var viewMap;
	var viewProps = ['viewModel', 'bindings', 'bindingFilters', 'bindingHandlers', 'bindingSources', 'computeds'];

	Gonrin.View = Backbone.View.extend({
		_super: Backbone.View,

		// Backbone.View constructor override:
		// sets up binding controls around call to super.
		constructor: function(options) {
			_.extend(this, _.pick(options||{}, viewProps));
			_super(this, 'constructor', arguments);
			this.applyBindings();
		},

		// Bindings list accessor:
		b: function() {
			return this._b || (this._b = []);
		},

		// Bindings definition:
		// this setting defines a DOM attribute name used to query for bindings.
		// Alternatively, this be replaced with a hash table of key/value pairs,
		// where 'key' is a DOM query and 'value' is its binding declaration.
		bindings: 'data-bind',

		// Setter options:
		// Defines an optional hashtable of options to be passed to setter operations.
		// Accepts a custom option '{save:true}' that will write to the model via ".save()".
		setterOptions: null,

		// Compiles a model context, then applies bindings to the view:
		// All Model->View relationships will be baked at the time of applying bindings;
		// changes in configuration to source attributes or view bindings will require a complete re-bind.
		applyBindings: function() {
			this.removeBindings();
			var self = this;
			var sources = _.clone(_.result(self, 'bindingSources'));
			var declarations = self.bindings;

			var options = self.setterOptions;
			var handlers = _.clone(bindingHandlers);
			var filters = _.clone(bindingFilters);
			var context = self._c = {};

			// Compile a complete set of binding handlers for the view:
			// mixes all custom handlers into a copy of default handlers.
			// Custom handlers defined as plain functions are registered as read-only setters.
			_.each(_.result(self, 'bindingHandlers')||{}, function(handler, name) {
				handlers[ name ] = makeHandler(handler);
			});

			// Compile a complete set of binding filters for the view:
			// mixes all custom filters into a copy of default filters.
			_.each(_.result(self, 'bindingFilters')||{}, function(filter, name) {
				filters[ name ] = makeFilter(filter);
			});

			// Add native 'model' and 'collection' data sources:
			self.model = addSourceToViewContext(self, context, options, 'model');
			self.viewModel = addSourceToViewContext(self, context, options, 'viewModel');
			self.collection = addSourceToViewContext(self, context, options, 'collection');

			// Support legacy "collection.view" API for rendering list items:
			// **Deprecated: will be removed after next release*.*
			if (self.collection && self.collection.view) {
				self.itemView = self.collection.view;
			}

			// Add all additional data sources:
			if (sources) {
				_.each(sources, function(source, sourceName) {
					sources[ sourceName ] = addSourceToViewContext(sources, context, options, sourceName, sourceName);
				});

				// Reapply resulting sources to view instance.
				self.bindingSources = sources;
			}

			// Add all computed view properties:
			_.each(_.result(self, 'computeds')||{}, function(computed, name) {
				var getter = isFunction(computed) ? computed : computed.get;
				var setter = computed.set;
				var deps = computed.deps;

				context[ name ] = function(value) {
					return (!isUndefined(value) && setter) ?
							setter.call(self, value) :
								getter.apply(self, getDepsFromViewContext(self._c, deps));
				};
			});

			// Create all bindings:
			// bindings are created from an object hash of query/binding declarations,
			// OR based on queried DOM attributes.
			if (isObject(declarations)) {

				// Object declaration method:
				// {'span.my-element': 'text:attribute'}

				_.each(declarations, function(elementDecs, selector) {
					// Get DOM jQuery reference:
					var $element = queryViewForSelector(self, selector);

					// flattern object notated binding declaration
					if (isObject(elementDecs)) {
						elementDecs = flattenBindingDeclaration(elementDecs);
					}

					// Ignore empty DOM queries (without errors):
					if ($element.length) {
						bindElementToView(self, $element, elementDecs, context, handlers, filters);
					}
				});

			} else {
				// DOM attributes declaration method:
				// <span data-bind='text:attribute'></span>

				// Create bindings for each matched element:
				queryViewForSelector(self, '['+declarations+']').each(function() {
					var $element = Backbone.$(this);
					bindElementToView(self, $element, $element.attr(declarations), context, handlers, filters);

				});
			}
		},

		// Gets a value from the binding context:
		getBinding: function(attribute) {
			return accessViewContext(this._c, attribute);
		},

		// Sets a value to the binding context:
		setBinding: function(attribute, value) {
			return accessViewContext(this._c, attribute, value);
		},

		// Disposes of all view bindings:
		removeBindings: function() {
			this._c = null;

			if (this._b) {
				while (this._b.length) {
					this._b.pop().dispose();
				}
			}
		},

		// Backbone.View.remove() override:
		// unbinds the view before performing native removal tasks.
		remove: function() {
			this.removeBindings();
			_super(this, 'remove', arguments);
		}

	}, mixins);

	// Gonrin.View -> Private
	// ---------------------

	// Adds a data source to a view:
	// Data sources are Backbone.Model and Backbone.Collection instances.
	// @param source: a source instance, or a function that returns a source.
	// @param context: the working binding context. All bindings in a view share a context.
	function addSourceToViewContext(source, context, options, name, prefix) {

		// Resolve source instance:
		source = _.result(source, name);

		// Ignore missing sources, and invoke non-instances:
		if (!source) return;

		// Add Backbone.Model source instance:
		if (isModel(source)) {

			// Establish source prefix:
			prefix = prefix ? prefix+'_' : '';

			// Create a read-only accessor for the model instance:
			context['$'+name] = function() {
				viewMap && viewMap.push([source, 'change']);
				return source;
			};

			// Compile all model attributes as accessors within the context:
			_.each(source.toJSON({computed:true}), function(value, attribute) {

				// Create named accessor functions:
				// -> Attributes from 'view.model' use their normal names.
				// -> Attributes from additional sources are named as 'source_attribute'.
				context[prefix+attribute] = function(value) {
					return accessViewDataAttribute(source, attribute, value, options);
				};
			});
		}
		// Add Backbone.Collection source instance:
		else if (isCollection(source)) {

			// Create a read-only accessor for the collection instance:
			context['$'+name] = function() {
				viewMap && viewMap.push([source, 'reset add remove sort update']);
				return source;
			};
		}

		// Return original object, or newly constructed data source:
		return source;
	}

	// Attribute data accessor:
	// exchanges individual attribute values with model sources.
	// This function is separated out from the accessor creation process for performance.
	// @param source: the model data source to interact with.
	// @param attribute: the model attribute to read/write.
	// @param value: the value to set, or 'undefined' to get the current value.
	function accessViewDataAttribute(source, attribute, value, options) {
		// Register the attribute to the bindings map, if enabled:
		viewMap && viewMap.push([source, 'change:'+attribute]);

		// Set attribute value when accessor is invoked with an argument:
		if (!isUndefined(value)) {

			// Set Object (non-null, non-array) hashtable value:
			if (!isObject(value) || isArray(value) || _.isDate(value)) {
				var val = value;
				value = {};
				value[attribute] = val;
			}

			// Set value:
			return options && options.save ? source.save(value, options) : source.set(value, options);
		}

		// Get the attribute value by default:
		return source.get(attribute);
	}

	// Queries element selectors within a view:
	// matches elements within the view, and the view's container element.
	function queryViewForSelector(view, selector) {

		if (selector === ':el' || selector === ':scope') return view.$el;
		var $elements = view.$(selector);
		// Include top-level view in bindings search:
		if (view.$el.is(selector)) {
			$elements = $elements.add(view.$el);
		}

		return $elements;
	}

	// Binds an element into a view:
	// The element's declarations are parsed, then a binding is created for each declared handler.
	// @param view: the parent View to bind into.
	// @param $element: the target element (as jQuery) to bind.
	// @param declarations: the string of binding declarations provided for the element.
	// @param context: a compiled binding context with all availabe view data.
	// @param handlers: a compiled handlers table with all native/custom handlers.
	function bindElementToView(view, $element, declarations, context, handlers, filters) {

		// Parse localized binding context:
		// parsing function is invoked with 'filters' and 'context' properties made available,
		// yeilds a native context object with element-specific bindings defined.
		try {
			var parserFunct = bindingCache[declarations] || (bindingCache[declarations] = new Function('$f','$c','with($f){with($c){return{'+ declarations +'}}}'));
			var bindings = parserFunct(filters, context);
		} catch (error) {
			throw('Error parsing bindings: "'+declarations +'"\n>> '+error);
		}

		// Format the 'events' option:
		// include events from the binding declaration along with a default 'change' trigger,
		// then format all event names with a '.Gonrin' namespace.
		var events = _.map(_.union(bindings.events || [], ['change']), function(name) {
			return name+'.Gonrin';
		}).join(' ');

		// Apply bindings from native context:
		_.each(bindings, function(accessor, handlerName) {

			// Validate that each defined handler method exists before binding:
			if (handlers.hasOwnProperty(handlerName)) {
				// Create and add binding to the view's list of handlers:
				view.b().push(new GonrinBinding(view, $element, handlers[handlerName], accessor, events, context, bindings));
			} else if (!allowedParams.hasOwnProperty(handlerName)) {
				throw('binding handler "'+ handlerName +'" is not defined.');
			}
		});
	}

	// Gets and sets view context data attributes:
	// used by the implementations of "getBinding" and "setBinding".
	function accessViewContext(context, attribute, value) {
		if (context && context.hasOwnProperty(attribute)) {
			return isUndefined(value) ? readAccessor(context[attribute]) : context[attribute](value);
		}
	}

	// Accesses an array of dependency properties from a view context:
	// used for mapping view dependencies by manual declaration.
	function getDepsFromViewContext(context, attributes) {
		var values = [];
		if (attributes && context) {
			for (var i=0, len=attributes.length; i < len; i++) {
				values.push(attributes[i] in context ? context[ attributes[i] ]() : null);
			}
		}
		return values;
	}

	// Converts a binding declaration object into a flattened string.
	// Input: {text: 'firstName', attr: {title: '"hello"'}}
	// Output: 'text:firstName,attr:{title:"hello"}'
	function flattenBindingDeclaration(declaration) {
		var result = [];

		for (var key in declaration) {
			var value = declaration[key];

			if (isObject(value)) {
				value = '{'+ flattenBindingDeclaration(value) +'}';
			}

			result.push(key +':'+ value);
		}

		return result.join(',');
	}


	// Gonrin.View -> Binding
	// ---------------------
	// The binding object connects an element to a bound handler.
	// @param view: the view object this binding is attached to.
	// @param $element: the target element (as jQuery) to bind.
	// @param handler: the handler object to apply (include all handler methods).
	// @param accessor: an accessor method from the binding context that exchanges data with the model.
	// @param events:
	// @param context:
	// @param bindings:
	function GonrinBinding(view, $element, handler, accessor, events, context, bindings) {

		var self = this;
		var tag = ($element[0].tagName).toLowerCase();
		var changable = (tag == 'input' || tag == 'select' || tag == 'textarea' || $element.prop('contenteditable') == 'true');
		var triggers = [];
		var reset = function(target) {
			self.$el && self.set(self.$el, readAccessor(accessor), target);
		};

		self.view = view;
		self.$el = $element;
		self.evt = events;
		_.extend(self, handler);

		// Initialize the binding:
		// allow the initializer to redefine/modify the attribute accessor if needed.
		accessor = self.init(self.$el, readAccessor(accessor), context, bindings) || accessor;

		// Set default binding, then initialize & map bindings:
		// each binding handler is invoked to populate its initial value.
		// While running a handler, all accessed attributes will be added to the handler's dependency map.
		viewMap = triggers;
		reset();
		viewMap = null;

		// Configure READ/GET-able binding. Requires:
		// => Form element.
		// => Binding handler has a getter method.
		// => Value accessor is a function.
		if (changable && handler.get && isFunction(accessor)) {
			self.$el.on(events, function(evt) {
				accessor(self.get(self.$el, readAccessor(accessor), evt));
			});
		}

		// Configure WRITE/SET-able binding. Requires:
		// => One or more events triggers.
		if (triggers.length) {
			for (var i=0, len=triggers.length; i < len; i++) {
				self.listenTo(triggers[i][0], triggers[i][1], reset);
			}
		}
	}

	_.extend(GonrinBinding.prototype, Backbone.Events, {

		// Pass-through binding methods:
		// for override by actual implementations.
		init: blankMethod,
		get: blankMethod,
		set: blankMethod,
		clean: blankMethod,

		// Destroys the binding:
		// all events and managed sub-views are killed.
		dispose: function() {
			this.clean();
			this.stopListening();
			this.$el.off(this.evt);
			this.$el = this.view = null;
		}
	});

	Gonrin.Collection = Backbone.Collection.extend({
		_super: Backbone.Collection,
		parse: function (response) {
			return response.objects;
		},
	});

	

	var AppView = Gonrin.AppView = Gonrin.View.extend({
		//$collection : null, //collection element
		//$object: null,
		//$choice: null,
		//collectionObject_tpl: null,
		//choiceObject_tpl: null,
		//object_tpl: null,
		initRender: function(){
			this.$el.empty();
			if(this.toolbar){
				($('<div/>').appendTo(this.$el)).append(this.toolbar);
			}
			if(this.progressbar){
				this.$el.append(this.progressbar);
			}
			return this;
		},
		initView: function(){
			var self = this;
			this.initToolbar();
			//progressbar:
			var progressbarhtml = '<div class="progress-bar progress-bar-success progress-bar-striped active" role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100" style="width: 100%">';
			progressbarhtml += '<span class="sr-only"></span>';
			progressbarhtml += '</div>';
			this.progressbar = $('<div/>').addClass("progress").css({"height":"4px", "visibility":"hidden", "margin-bottom": "20px"}).html(progressbarhtml);

			this.progressbar.show = function(percent){
				self.progressbar.css("visibility","visible");
			};
			this.progressbar.hide = function(){
				self.progressbar.css("visibility","hidden");
			};
			//init messbox
			this.dialog = new Gonrin.Dialog();

			//init template
			this.$object = $('<div/>');
			this.$choice = $('<div/>');
			this.$collection = $('<div/>');

			this.initTemplate();
			this.initRender();
			return this;
		},

		initToolbar: function(){
			var self = this;
			this.toolbar = $('<div/>').addClass("toolbar btn-group").attr('role','group');
			this.toolbar.cid = _.uniqueId('toolbar');

			this.toolbar.addButton = function($btn, callback){
				self.toolbar.append($btn);
				$btn.bind("click", callback);
			}
			this.onInitToolbar();
			return this;
		},
		onInitToolbar: function(){ return this},
		initTemplate: function(){return this;},
		onInitTemplateCompleted: function(){
			this.applyBindings();
			this.applyTransforms();
			return this;
		},
		applyTransforms: function(){return this;},  
	});

	Gonrin.AppCollectionView = Gonrin.AppView.extend({
		initTemplate: function(){
			var self = this;
			var templates = _.result(this.model.entity.views, 'template') || null;
			if((templates != null) && (templates['$collectionObject'])){
				require([ templates['$collectionObject'] ], function ( tpl ) {
					var template = _.template(tpl);
					self.collectionObject_tpl = template(); 
				});

			}else{
				var htmltext = '<tr>'; 
				var collection_columns = this.model.entity.views.collection_columns;
				_.each(collection_columns, function(col) {
					htmltext += '<td><span data-bind="text:' + col +'"></span></td>';
				});
				htmltext += '</tr>';
				this.collectionObject_tpl = htmltext;
			}

			return this;
		},
		onInitToolbar: function(){
			var self = this;

			var createBtn = $('<button/>').attr({type:'button', class:'btn btn-default', 'btn-name':'create'}).html('Create');
			this.toolbar.addButton.call(this,createBtn, function(){
				self.progressbar.hide();
				window.location.hash = self.model.entity.collection_name + "/actioncreate";
				//alert("create");
				//self.progressbar.hide();
			});

			var deleteBtn = $('<button/>').attr({type:'button', class:'btn btn-default', 'btn-name':'delete'}).html('Delete');
			this.toolbar.addButton.call(this,deleteBtn, function(){
				console.log("delete");
				self.progressbar.hide();
			});
			//console.log(this.toolbar);
			return this;
		},
		render: function(){
			var self = this;

			var table = $('<table/>').attr('class','table list-table table-striped').html('<thead><tr></tr></thead><tbody></tbody>');
			this.$collection.append(table).appendTo(this.$el);
			var thead = this.$collection.find('thead').find('tr');
			//add table header dynamic
			var label_columns = self.model.entity.views.label_columns;
			var collection_columns = self.model.entity.views.collection_columns;

			_.each(collection_columns, function(col) {
				var found = false;
				_.each(label_columns, function(obj) {
					_.each(obj, function(prop, key){
						if(key == col){
							var thcol = $("<th>").html(prop);
							thead.append(thcol);
							found = true;
							//return;
						}
					});
					if(found == true){
						return;
					}
				});

				if(found == false){
					var thcol = $("<th>").html(col);
					thead.append(thcol);
				}

			});
			//Phan tich object_tpl de ra header

			var tbody = this.$collection.find('tbody');
			for(var i = 0; i < this.model.length; i++) {
				var objView = new Gonrin.AppCollectionObjectView({model: this.model.at(i), el: self.collectionObject_tpl},{onObjectSelected: this.onObjectSelected, originObject: this});
				tbody.append(objView.$el);
				objView.render();
			}	          
			return this;
		},
		onObjectSelected: function(object){
			window.location.hash = this.model.entity.collection_name + "/" + "actionedit/" + object.get('id');
		},
	});

	Gonrin.AppObjectView = Gonrin.AppView.extend({
		render: function(){
			this.$el.append(this.$object);
			//may be render excute after require template, need another applyBindings
			if(this.$object.html() !== ''){
				this.applyBindings();
			}
			console.log('AppObjectView render');
			return this;
		},

		onInitToolbar: function(){
			var self = this;

			var backBtn = $('<button/>').attr({type:'button', class:'btn btn-default', 'btn-name':'back'}).html('Back');
			this.toolbar.addButton.call(this,backBtn, function(){
				self.progressbar.hide();
				window.location.hash = self.model.entity.collection_name;

			});

			var savecloseBtn = $('<button/>').attr({type:'button', class:'btn btn-default', 'btn-name':'saveclose'}).html('Save and Close');
			this.toolbar.addButton.call(this,savecloseBtn, function(){
				self.model.save(null,{
					success: function (model, respose, options) {
						//self.alertMessage("The model has been saved to the server", true);
						console.log('Save OK');
						self.progressbar.hide();
						window.location.hash = self.model.entity.collection_name;
					},
					error: function (model, xhr, options) {
						//self.alertMessage("Something went wrong while processing the model", false);
						console.log('Save error');
						self.progressbar.hide();
					}
				});
			});

			var saveBtn = $('<button/>').attr({type:'button', class:'btn btn-default', 'btn-name':'save'}).html('Save');
			this.toolbar.addButton.call(this,saveBtn, function(){
				//alert("delete");
				self.progressbar.show();
				self.model.save(null,{
					success: function (model, respose, options) {
						//self.alertMessage("The model has been saved to the server", true);
						console.log('Save OK');
						self.progressbar.hide();
					},
					error: function (model, xhr, options) {
						//self.alertMessage("Something went wrong while processing the model", false);
						console.log('Save error');
						self.progressbar.hide();
					}
				});

			});

			var deleteBtn = $('<button/>').attr({type:'button', class:'btn btn-default', 'btn-name':'delete'}).html('Delete');
			this.toolbar.addButton.call(this,deleteBtn, function(){
				alert("delete");
				self.progressbar.hide();
			});

			return this;
		},
		initTemplate: function(){
			var self = this;

			var templates = _.result(this.model.entity.views, 'template') || null;
			if((templates != null) && (templates['$object'] != null)){
				require([ templates['$object'] ], function ( tpl ) {
					var template = _.template(tpl);
					self.object_tpl = template(); 
					self.$object.html(self.object_tpl);
					self.onInitTemplateCompleted();

				});

			}else{
				//auto init template collection view. base on schema.; list_colums
				//self.onInitTemplateCompleted();
			}
			return this;
		},
		applyTransforms: function(){
			console.log('applyTransforms');
			var self = this;
			if(this.$object.html() == ''){
				return this;
			};

			//list
			var listhelper = self.$object.find("a[data-type=data-helper-list]");
			_.each(listhelper, function(listitem){
				var $listitem = $(listitem);
				var ref = $listitem.attr("data-ref");
				var refname = $listitem.attr("data-helper-list");
				var displayEl = self.$object.find("input[data-helper-display="+ refname +"]");
				var valueEl = self.$object.find("input[data-helper-value="+ refname +"]");

				console.log($listitem.attr('data-value'));
				console.log(valueEl.val());
				if(valueEl.val() != $listitem.attr('data-value')){
					displayEl.val($listitem.text());
				}

				$listitem.bind("click", function(){
					displayEl.val($listitem.text());
					valueEl.val($listitem.attr('data-value'));
					valueEl.trigger('change');
				});
			});
			//endlist

			//wysiwyg
			var wysiwyg = self.$object.find(".wysiwyg-editor");
			_.each(wysiwyg, function(el){
				$(el).cleditor();
			});
			//end wysiwyg


			//datepicker
			self.$object.find('input[data-type=datetime]').datetimepicker({
				format: 'DD/MM/YYYY HH:mm'
			});
			//number
			self.$object.find('input[data-type=number]').numeric();

			//reference
			var helper = self.$object.find("button[data-type=data-helper-ref]");


			if(helper){
				var ref = helper.attr("data-ref");
				var refname = helper.attr("data-helper-button");
				var displayEl = self.$object.find("input[data-helper-display="+ refname +"]");
				var displayAttr = displayEl.attr("data-helper-display-attribute");
				var valueEl = self.$object.find("input[data-helper-value="+ refname +"]");

				if(ref){
					require([ ref ], function ( RefEntity ) {
						if((valueEl.val() != null)&&(displayAttr != 'id')){
							var entity = new RefEntity().initEntity({collection:false,choice:false}).initViews();
							//console.log(entity);
							entity.object.set('id',valueEl.val());
							entity.object.fetch({
								success: function (data) {
									console.log(data);
									displayEl.val(data.get(displayAttr));
									valueEl.val(data.get('id'));
									valueEl.trigger('change');
								},
								//error:errorHandler,
							});
						}
						helper.bind( "click",function(){
							var entity = new RefEntity().initEntity({collection:false,object:false}).initViews();
							entity.choice.fetch({
								success: function (data) {
									entity.renderChoice();
								},
								//error:errorHandler,
							});
							self.dialog.dialog({
								message: entity.views.choice_view.$el,
								title: "Please select...",
								buttons: {
									success: {
										label: "Select",
										className: "btn-success",
										callback: function() {
											console.log(entity.views.choice_view.selected);
											var selected = entity.views.choice_view.selected[0];
											displayEl.val(selected.get(displayAttr));
											valueEl.val(selected.get('id'));
											valueEl.trigger('change');

										}
									},
									danger: {
										label: "Close",
										className: "btn-default",
										callback: function() {
											console.log("uh oh, look out!");
										}
									},
								}
							});

						});//end bind
					});
				}//if ref

			}

			return this;
		},

	});
	var choiceViewProps = ['origin'];
	Gonrin.AppChoiceView = Gonrin.AppView.extend({
		selected:[],
		multiple:false,
		constructor: function(attributes, options) {
			_.extend(this, _.pick(options||{}, choiceViewProps));
			_super(this, 'constructor', arguments);
		},
		render: function(){
			var self = this;
			var table = $('<table/>').attr('class','table list-table table-striped').html('<thead><tr></tr></thead><tbody></tbody>');
			this.$choice.append(table).appendTo(this.$el);
			var thead = this.$choice.find('thead');
			//add table header dynamic
			var label_columns = self.model.entity.views.label_columns;
			var choice_columns = self.model.entity.views.choice_columns;

			_.each(label_columns, function(col) {
				_.each(col, function(prop, key){
					if(_.indexOf(choice_columns, key) != -1){
						var thcol = $("<th>").html(prop);
						thead.append(thcol);
					}
				});
			});
			var tbody = this.$choice.find('tbody');
			for(var i = 0; i < this.model.length; i++) {
				var objView = new Gonrin.AppCollectionObjectView({model: this.model.at(i), el: self.choiceObject_tpl},{onObjectSelected: this.onObjectSelected, originObject: this});
				tbody.append(objView.$el);
				objView.render();
			}
			return this;
		},
		onObjectSelected: function(object){

			if(this.multiple == true){
				this.selected.push(object);
			}else{
				this.selected.splice(0, this.selected.length);
				this.selected.push(object);
			}
		},
		initTemplate: function(){
			var self = this;
			//auto init template collection view. base on schema.; list_colums
			var templates = _.result(this.model.entity.views, 'template') || null;
			if((templates != null) && (templates['$choiceObject'])){
				require([ templates['$choiceObject'] ], function ( tpl ) {
					var template = _.template(tpl);
					self.choiceObject_tpl = template(); 

				});
			}else{
				//auto cread item
				var htmltext = '<tr>'; 
				var choice_columns = this.model.entity.views.choice_columns;
				_.each(choice_columns, function(col) {
					htmltext += '<td><span data-bind="text:' + col +'"></span></td>';
				});
				htmltext += '</tr>';
				this.choiceObject_tpl = htmltext;
			}
			return this;
		},
	});

	var collectionObjectViewProps = ['onObjectSelected','originObject'];
	Gonrin.AppCollectionObjectView = Gonrin.View.extend({
		constructor: function(attributes, options) {
			_.extend(this, _.pick(options||{}, collectionObjectViewProps));
			_super(this, 'constructor', arguments);
		},
		render: function(){
			var self = this;
			this.applyBindings();
			this.bindEvents();
			return this;
		},
		bindEvents:function(){
			var self = this;
			if(self.originObject){
				this.$el.bind("click",function(){self.onObjectSelected.call(self.originObject,self.model)});
			}
		},
		onObjectSelected: function(arg){return this;},
	});

	var Entity = Gonrin.Entity = function(attributes){
		this.cid = _.uniqueId('entity');
		this._is_initViews = false;
		this.initialize.apply(this, arguments);
	};

	// Set up inheritance for the entity
	Entity.extend = extend;

	_.extend(Gonrin.Entity.prototype, Backbone.Events, {
		initialize: blankMethod,
		render: function() {
			return this;
		},
		initEntity: function(options){
			options = options||{};
			var self = this;
			var schema = _.result(this, 'schema')||{};
			var attrs = {};
			_.each(schema, function(props, key) {
				if(isObject(props)){
					attrs[key] = _.result(props, 'default');
				}
			});

			if(options.collection != false){
				this.collection = new Gonrin.Collection(Gonrin.Model);
				this.collection.entity = this;
				if(self.url_prefix && self.collection_name){
					this.collection.url =  self.url_prefix + self.collection_name;
				}
			}

			if(options.choice != false){
				this.choice = new Gonrin.Collection(Gonrin.Model);
				this.choice.entity = this;

				if(self.url_prefix && self.collection_name){
					this.choice.url =  self.url_prefix + self.collection_name;
				}
			}

			if(options.object != false){
				this.object = new Gonrin.Model(attrs);
				this.object.entity = this;
				if(self.url_prefix && self.collection_name){
					this.object.urlRoot =  self.url_prefix + self.collection_name;
				}
			}
			return this;
		},
		initViews: function($el){
			//views:
			//empty old data before applyBinding
			if($el) $el.empty();
			var self = this;
			this.views = _.result(this, 'views') || {};
			this.views = _.extend( { collection_view: null, object_view: null, choice_view: null} ,this.views);

			if(self.collection){
				if(_.isNull(this.views.collection_view) || _.isUndefined(this.views.collection_view)){
					this.views.collection_view = new Gonrin.AppCollectionView({model:self.collection, el: $el}).initView();
					this.views.collection_view.entity = self;
				}
			}
			if(self.object){
				if(_.isNull(this.views.object_view) || _.isUndefined(this.views.object_view)){
					this.views.object_view = new Gonrin.AppObjectView({model:self.object, el: $el}).initView();
					this.views.object_view.entity = self;
				}
			}

			if(self.choice){
				if(_.isNull(this.views.choice_view) || _.isUndefined(this.views.choice_view)){
					this.views.choice_view = new Gonrin.AppChoiceView({model:self.choice}).initView();
				}
			}
			var schema = _.result(this, 'schema')||{};
			var columns = [];
			var labels = []; 
			_.each(schema, function(props, key) {
				if(isObject(props)){
					columns.push(key);
					var obj = {};
					obj[key] = key;
					labels.push(obj);
				}
			});

			this.views.label_columns = _.result(this.views,'label_columns') || [];

			//label_colums 
			function findKeyInLabels(key, labelArray){
				var found = false;
				_.each(labelArray, function(obj){
					_.each(obj, function(value, objkey) {
						if(objkey == key){
							found = true;
							return;
						}
						if(found) return;

					});
					if(found) return;
				});
				return found;
			};
			_.each(labels, function(obj){
				_.each(obj, function(value, key) {
					if(findKeyInLabels(key, self.views.label_columns)){
						return;
					}else{
						self.views.label_columns.push(obj);
					}
				});

			});
			//collection_colums 
			this.views.collection_columns = _.result(this.views,'collection_columns') || [];
			this.views.choice_columns = _.result(this.views,'choice_columns') || [];

			_.each(self.views.collection_columns, function(col){
				if(_.indexOf(columns, col) != -1){
					return
				}else{
					self.views.collection_columns = _.without(self.views.collection_columns, col);
				}
			});
			_.each(self.views.choice_columns, function(col){
				if(_.indexOf(columns, col) != -1){
					return
				}else{
					self.views.choice_columns = _.without(self.views.choice_columns, col);
				}
			});
			this._is_initViews = true;
			return this;
		},
		renderCollection(){
			if(this._is_initViews == true){
				this.views.collection_view.render();
			}
		},
		renderObject(){
			if(this._is_initViews == true){
				this.views.object_view.render();
			}
		},
		renderChoice(){
			if(this._is_initViews == true){
				this.views.choice_view.render();
			}
		},
		initializeModelAttribute: function(){
			return this;
		},
	});
	
	
	
	// Gonrin.LoginView
	// ----------
	var loginViewMap;
	var loginViewProps = ['app'];

	Gonrin.LoginView = Backbone.View.extend({
		_super: Backbone.View,

		// Backbone.View constructor override:
		// sets up binding controls around call to super.
		constructor: function(options) {
			_.extend(this, _.pick(options||{}, loginViewProps));
			_super(this, 'constructor', arguments);
		},
	});

	// Gonrin.LoginView
	// ----------
	var navbarViewMap;
	var NavbarViewProps = ['app','entries'];

	var navbarTemplate = '<ul class="page-navbar-menu" data-keep-expanded="false" data-auto-scroll="true" data-slide-speed="200">'
		+ '<li class="navbar-toggler-wrapper"><div class="navbar-toggler"></div></li></ul>';
	
	Gonrin.NavbarView = Backbone.View.extend({
		_super: Backbone.View,
		constructor: function(options) {
			_.extend(this, _.pick(options||{}, NavbarViewProps));
			_super(this, 'constructor', arguments);
			//this.load_navbar_menu();
			//this.handle_navbar_toggler();
			return this;
		},
		render:function(){
			this.load_navbar_menu();
			this.handle_navbar_toggler();
			return this;
		},
		load_navbar_entries: function($el, entries, is_root){
			var self = this;
			if(entries && (entries.length > 0)){
				_.each(entries, function(entry, index){
					var entry_type = _.result(entry, 'type');
					var entry_collection_name = _.result(entry, 'collection_name');
					var entry_ref = _.result(entry, '$ref');
					var entry_text = _.result(entry, 'text');
					var entry_icon = _.result(entry, 'icon');
					var entry_entries = _.result(entry, 'entries');
					
					var _html = '';
					if(entry_type === "category"){
						_html = _html + '<a href="javascript:;">';
						if(entry_icon){
							_html = _html + '<img class="nav-menu-icon" src="' + entry_icon + '"/>'; //change icon
						}
						
						_html = _html + '<span class="title">'+ entry_text +'</span><span class="arrow "></span>';
						_html = _html + '</a>';
					}
					
					if(entry_type === "link"){
						_html = _html + '<a href="'+ entry_ref +'">';
						if(entry_icon){
							_html = _html + '<img class="nav-menu-icon" src="' + entry_icon + '"/>'; //change icon
						}
						_html = _html + '<span class="title">'+ entry_text +'</span>';
						_html = _html + '</a>';
					}
					
					if(entry_type === "entity"){
						_html = _html + '<a class="ajaxify" href="javascript:;">';
						
						if(entry_icon){
							_html = _html + '<img class="nav-menu-icon" src="' + entry_icon + '"/>'; //change icon
						}
						_html = _html + '<span class="title">'+ entry_text +'</span>';
						_html = _html + '</a>';
					}
					
					var $entry = $('<li>').html(_html);
					
					if((index === 0)&&(is_root === true) &&(entry_type === "category")){
						$entry.addClass("start active open");
						$entry.find('span.arrow').addClass("open");
						$entry.children('a').append($('<span>').addClass("selected"));
					}
					if($el){
						$el.append($entry);
					}
					
					if (entry_entries) {
						var _nav_list = $('<ul>').addClass("sub-menu").appendTo($entry);
						self.load_navbar_entries(_nav_list, entry_entries, false);
					}
					// load route to router
					if(app.router){
						app.router.load_entity(entry);
					}
					self.handle_navbar_menu($entry, entry);
				});// end _.each
			};
			return this;
		},
		load_navbar_menu: function(){
			var self = this;
			this.$el.addClass("page-navbar navbar-collapse collapse").html(navbarTemplate);
			var _nav_list = this.$el.find('ul.page-navbar-menu')
			this.load_navbar_entries(_nav_list, this.entries, true);
			
			return this;
		},
		handle_navbar_menu : function ($entry, entry) {
			var self = this;
	       
			if(entry.type === "category"){
				var $a = $entry.children('a');
				if($a === undefined){
					return this;
				}
				$a.bind("click", function(e){
		        	var hasSubMenu = $(this).next().hasClass('sub-menu');
		            if ($(this).next().hasClass('sub-menu always-open')) {
		                return;
		            }
		            
		            var parent = $entry.parent().parent();
		            
		            var menu = self.$el.find('.page-navbar-menu');
		            var sub = $(this).next();

		            var autoScroll = menu.data("auto-scroll");
		            var slideSpeed = parseInt(menu.data("slide-speed"));
		            var keepExpand = menu.data("keep-expanded");

		            if (keepExpand !== true) {
		                parent.children('li.open').children('a').children('.arrow').removeClass('open');
		                parent.children('li.open').removeClass('open');
		            }
		         
		            if (sub.is(':visible')) {
		                $('.arrow', $(this)).removeClass("open");
		                $(this).parent().removeClass("open");
		          
		            } else if (hasSubMenu) {
		                $('.arrow', $(this)).addClass("open");
		                $(this).parent().addClass("open");
		         
		            };
		            //e.preventDefault();
		        });
			};
			if(entry.type === "entity"){
				var $a = $entry.children('a');
				if($a === undefined){
					return this;
				}
				$a.bind("click", function(e){
					e.preventDefault();
		            var url = $entry.attr("href");
		            var menuContainer = self.$el.find('ul');
		            
		            menuContainer.children('li.active').removeClass('active');
		            menuContainer.children('li.open').removeClass('open');
		            menuContainer.find('span.arrow').removeClass('open');
		            menuContainer.find('span.selected').remove();

		            $(this).parents('li').each(function (){
		            	$(this).addClass('active open');
		            	$(this).children('a').children('span.arrow').addClass("open");
		            	$(this).children('a').append($('<span>').addClass("selected"));
		            });
		            $(this).parents('li').addClass('active');
		            if(entry.collection_name){
		            	app.router.navigate(entry.collection_name);
		            }
				});
			};
	        return this;
	        
		},
		// Hanles sidebar toggler
	    handle_navbar_toggler : function () {
	        //var body = $('body');
	        /*if ($.cookie && $.cookie('sidebar_closed') === '1' && Metronic.getViewPort().width >= resBreakpointMd) {
	            $('body').addClass('page-navbar-closed');
	            $('.page-navbar-menu').addClass('page-navbar-menu-closed');
	        }*/

	        // handle sidebar show/hide
	        var _self = this;
	        
	        this.$el.on('click', '.navbar-toggler', function (e) {
	        	var body = $('body');
	        	var _navMenu = $('.page-navbar-menu');
	        	var _navbar = _self.$el;
	        	var _navMenu = _self.$el.find('.page-navbar-menu');
	            //$(".sidebar-search", sidebar).removeClass("open");

	            if (body.hasClass("page-navbar-closed")) {
	                body.removeClass("page-navbar-closed");
	                _navMenu.removeClass("page-navbar-menu-closed");
	                /*if ($.cookie) {
	                    $.cookie('navbar_closed', '0');
	                }*/
	            } else {
	                body.addClass("page-navbar-closed");
	                _navMenu.addClass("page-navbar-menu-closed");
	                if (body.hasClass("page-navbar-fixed")) {
	                	_navMenu.trigger("mouseleave");
	                }
	                /*if ($.cookie) {
	                    $.cookie('navbar_closed', '1');
	                }*/
	            }
	            $(window).trigger('resize');
	        });
	        return this;
	    },
	    
	});

	var App = Gonrin.App = function(attributes){
		var self = this;
		this.cid = _.uniqueId('app');
		this.initialize.apply(this, arguments);
		this.navbar = null;
		
		//
		this.notification = null;
		//this.message = new Gonrin.Dialog();
		this.session = {token:null, expired:null};
		this.permission = null;
		
		//load layout
		
		/*this.on("login_succeeded.app", function(){
	    	
	    });*/
	};
	// Set up inheritance for the app
	App.extend = extend;
	
	_.extend(Gonrin.App.prototype, Backbone.Events, {
		initialize: blankMethod,
		//session
		check_valid_session: function(){
			if(this.session){
				if(this.session.token != null){
					return true;
				}
			}
			return false;
		},
		load_layout: function(){
			var _self = this;
			require(['text!tpl/base/layout.html'], function (layout_tpl) {
				var layout = _.template(layout_tpl);
				$('body').html(layout);
				_self.$layout_header = $('body').find(".page-header");
				_self.$layout_content = $('body').find(".page-content");
				//_self.$layout_navbar = $('body').find(".page-navbar-wrapper");
				var $navbar = $('body').find(".page-navbar-wrapper");
				_self.load_navbar($navbar);
            });
			return this;
		},
		load_navbar: function($navbar){
			//load navbars
			/*var data = JSON.stringify({
   		        user_id: '123',
   		    });*/
			var self = this;
			$.ajax({
       		    url: 'static/sample_nav.js',
       		    //data: data,
       		    dataType:"json",
       		    success: function (nav_data) {
       		    	self.navbar = new Gonrin.NavbarView({app: self, entries: nav_data,el: $navbar});
       		    	self.navbar.render();
       		    },
       		    error: function(XMLHttpRequest, textStatus, errorThrown) {
       		    	app.notify("Nav error");
       		    	//self.alertMessage("some error");
       		    }
       		});
			return this;
		},
		get_permission: function(){
			
		},
		notify:function(args){
			if($.notify){
				$.notify(args);
			}
		},
		dialog:function(){
			
		},
	});

	//router
	var Router = Gonrin.Router = Backbone.Router.extend({
		initialize: function(options){
			if (options.app) this.app = options.app;
			return this;
		},
		current_page: null,
		load_error_page: function(){
			//load error view
			console.log("load error view");
		},
		load_entity: function(nav_entry){
			var self = this;
        	if(nav_entry && nav_entry.collection_name && (nav_entry.type === "entity") && (nav_entry['$ref'])){
        		//entry_path = entry_path + '(?action/:action)(/id/:id)(/filter/:filter)'
    			var entry_path = this.build_route_path(nav_entry);
    			this.route(entry_path, nav_entry.collection_name, function(action,id){
    				require([ nav_entry['$ref'] ], function ( Entity) {
    					console.log('loaded Entity ' + nav_entry['$ref']);
    					console.log(action + ' ' + id );
    					if((action == null)||(action == 'list')){
    						var entity = new Entity();
    						/*entity.collection.fetch({
    	                        success: function (data) {
    	                        	entity.collection_view.render();
    	                        },
    	                        error:self.load_error_page,
    	                    });*/
    	        			return;
    					};
    					
    					if(action == 'create'){
    						
    					};
    					if(action == 'read'){
    						
    					};
    					if(action == 'update'){
    						
    					};
    					if(action == 'delete'){
    						
    					};
    					
    					
    				});
    			});
            };
            return this;
        	
        },
        build_route_path:function(entry){
			var entry_path = entry.collection_name + '(?action/:action)(/id/:id)';
			if(_.result(entry,'route_extra_params')){
				
			}
			return entry_path;
		},
		
	});

	Router.prototype.navigate = _.wrap(Backbone.Router.prototype.navigate, function(){ 
		var args = _.toArray(arguments);
		var original = args.shift();
		if((args.length > 0) && (args.length < 3)){
			if(!args[1]){
				args.push(true);
			}
			Backbone.trigger('before:hash-change', args);
			var res = original.apply(this, args);
			Backbone.trigger('hash-changed');
			return res;
		}
		return this;
	});











	//Gonrin.Dialog`
	Gonrin.Dialog = function(attributes){
		this.cid = _.uniqueId('dialog');
		this.initialize.apply(this, arguments);
	};

	// Set up inheritance for the dialog
	Gonrin.Dialog.extend = extend;

	var templates = {
			dialog:
				"<div class='bootbox modal' tabindex='-1' role='dialog'>" +
				"<div class='modal-dialog'>" +
				"<div class='modal-content'>" +
				"<div class='modal-body'><div class='bootbox-body'></div></div>" +
				"</div>" +
				"</div>" +
				"</div>",
				header:
					"<div class='modal-header'>" +
					"<h4 class='modal-title'></h4>" +
					"</div>",
					footer:
						"<div class='modal-footer'></div>",
						closeButton:
							"<button type='button' class='bootbox-close-button close' data-dismiss='modal' aria-hidden='true'>&times;</button>",
							form:
								"<form class='bootbox-form'></form>",
								inputs: {
									text:
										"<input class='bootbox-input bootbox-input-text form-control' autocomplete=off type=text />",
										textarea:
											"<textarea class='bootbox-input bootbox-input-textarea form-control'></textarea>",
											email:
												"<input class='bootbox-input bootbox-input-email form-control' autocomplete='off' type='email' />",
												select:
													"<select class='bootbox-input bootbox-input-select form-control'></select>",
													checkbox:
														"<div class='checkbox'><label><input class='bootbox-input bootbox-input-checkbox' type='checkbox' /></label></div>",
														date:
															"<input class='bootbox-input bootbox-input-date form-control' autocomplete=off type='date' />",
															time:
																"<input class='bootbox-input bootbox-input-time form-control' autocomplete=off type='time' />",
																number:
																	"<input class='bootbox-input bootbox-input-number form-control' autocomplete=off type='number' />",
																	password:
																		"<input class='bootbox-input bootbox-input-password form-control' autocomplete='off' type='password' />"
								}
	};

	var defaults = {
			// default language
			locale: "en",
			// show backdrop or not. Default to static so user has to interact with dialog
			backdrop: "static",
			// animate the modal in/out
			animate: true,
			// additional class string applied to the top level dialog
			className: null,
			// whether or not to include a close button
			closeButton: true,
			// show the dialog immediately by default
			show: true,
			// dialog container
			container: "body"
	};

	/**
	 * @private
	 */
	function _t(key) {
		var locale = locales[defaults.locale];
		return locale ? locale[key] : locales.en[key];
	}

	function processCallback(e, dialog, callback) {
		e.stopPropagation();
		e.preventDefault();

		// by default we assume a callback will get rid of the dialog,
		// although it is given the opportunity to override this

		// so, if the callback can be invoked and it *explicitly returns false*
		// then we'll set a flag to keep the dialog active...
		var preserveDialog = $.isFunction(callback) && callback.call(dialog, e) === false;

		// ... otherwise we'll bin it
		if (!preserveDialog) {
			dialog.modal("hide");
		}
	}

	function getKeyLength(obj) {
		// @TODO defer to Object.keys(x).length if available?
		var k, t = 0;
		for (k in obj) {
			t ++;
		}
		return t;
	}

	function each(collection, iterator) {
		var index = 0;
		$.each(collection, function(key, value) {
			iterator(key, value, index++);
		});
	}

	function sanitize(options) {
		var buttons;
		var total;

		if (typeof options !== "object") {
			throw new Error("Please supply an object of options");
		}

		if (!options.message) {
			throw new Error("Please specify a message");
		}

		// make sure any supplied options take precedence over defaults
		options = $.extend({}, defaults, options);

		if (!options.buttons) {
			options.buttons = {};
		}

		buttons = options.buttons;

		total = getKeyLength(buttons);

		each(buttons, function(key, button, index) {

			if ($.isFunction(button)) {
				// short form, assume value is our callback. Since button
				// isn't an object it isn't a reference either so re-assign it
				button = buttons[key] = {
						callback: button
				};
			}

			// before any further checks make sure by now button is the correct type
			if ($.type(button) !== "object") {
				throw new Error("button with key " + key + " must be an object");
			}

			if (!button.label) {
				// the lack of an explicit label means we'll assume the key is good enough
				button.label = key;
			}

			if (!button.className) {
				if (total <= 2 && index === total-1) {
					// always add a primary to the main option in a two-button dialog
					button.className = "btn-primary";
				} else {
					button.className = "btn-default";
				}
			}
		});

		return options;
	}

	/**
	 * map a flexible set of arguments into a single returned object
	 * if args.length is already one just return it, otherwise
	 * use the properties argument to map the unnamed args to
	 * object properties
	 * so in the latter case:
	 * mapArguments(["foo", $.noop], ["message", "callback"])
	 * -> { message: "foo", callback: $.noop }
	 */
	function mapArguments(args, properties) {
		var argn = args.length;
		var options = {};

		if (argn < 1 || argn > 2) {
			throw new Error("Invalid argument length");
		}

		if (argn === 2 || typeof args[0] === "string") {
			options[properties[0]] = args[0];
			options[properties[1]] = args[1];
		} else {
			options = args[0];
		}

		return options;
	}

	/**
	 * merge a set of default dialog options with user supplied arguments
	 */
	function mergeArguments(defaults, args, properties) {
		return $.extend(
				// deep merge
				true,
				// ensure the target is an empty, unreferenced object
				{},
				// the base options object for this type of dialog (often just buttons)
				defaults,
				// args could be an object or array; if it's an array properties will
				// map it to a proper options object
				mapArguments(
						args,
						properties
				)
		);
	}

	/**
	 * this entry-level method makes heavy use of composition to take a simple
	 * range of inputs and return valid options suitable for passing to bootbox.dialog
	 */
	function mergeDialogOptions(className, labels, properties, args) {
		//  build up a base set of dialog properties
		var baseOptions = {
				className: "bootbox-" + className,
				buttons: createLabels.apply(null, labels)
		};

		// ensure the buttons properties generated, *after* merging
		// with user args are still valid against the supplied labels
		return validateButtons(
				// merge the generated base properties with user supplied arguments
				mergeArguments(
						baseOptions,
						args,
						// if args.length > 1, properties specify how each arg maps to an object key
						properties
				),
				labels
		);
	}

	/**
	 * from a given list of arguments return a suitable object of button labels
	 * all this does is normalise the given labels and translate them where possible
	 * e.g. "ok", "confirm" -> { ok: "OK, cancel: "Annuleren" }
	 */
	function createLabels() {
		var buttons = {};

		for (var i = 0, j = arguments.length; i < j; i++) {
			var argument = arguments[i];
			var key = argument.toLowerCase();
			var value = argument.toUpperCase();

			buttons[key] = {
					label: _t(value)
			};
		}

		return buttons;
	}

	function validateButtons(options, buttons) {
		var allowedButtons = {};
		each(buttons, function(key, value) {
			allowedButtons[value] = true;
		});

		each(options.buttons, function(key) {
			if (allowedButtons[key] === undefined) {
				throw new Error("button key " + key + " is not allowed (options are " + buttons.join("\n") + ")");
			}
		});

		return options;
	}

	_.extend(Gonrin.Dialog.prototype, Backbone.Events, {
		initialize: blankMethod,
		dialog : function(options) {
			options = sanitize(options);

			var dialog = $(templates.dialog);
			var innerDialog = dialog.find(".modal-dialog");
			var body = dialog.find(".modal-body");
			var buttons = options.buttons;
			var buttonStr = "";
			var callbacks = {
					onEscape: options.onEscape
			};
			if ($.fn.modal === undefined) {
				throw new Error(
						"$.fn.modal is not defined; please double check you have included " +
						"the Bootstrap JavaScript library. See http://getbootstrap.com/javascript/ " +
						"for more details."
				);
			};


			each(buttons, function(key, button) {

				// @TODO I don't like this string appending to itself; bit dirty. Needs reworking
				// can we just build up button elements instead? slower but neater. Then button
				// can just become a template too
				buttonStr += "<button data-bb-handler='" + key + "' type='button' class='btn " + button.className + "'>" + button.label + "</button>";
				callbacks[key] = button.callback;
			});

			body.find(".bootbox-body").html(options.message);

			if (options.animate === true) {
				dialog.addClass("fade");
			}

			if (options.className) {
				dialog.addClass(options.className);
			}

			if (options.size === "large") {
				innerDialog.addClass("modal-lg");
			} else if (options.size === "small") {
				innerDialog.addClass("modal-sm");
			}

			if (options.title) {
				body.before(templates.header);
			}

			if (options.closeButton) {
				var closeButton = $(templates.closeButton);

				if (options.title) {
					dialog.find(".modal-header").prepend(closeButton);
				} else {
					closeButton.css("margin-top", "-10px").prependTo(body);
				}
			}

			if (options.title) {
				dialog.find(".modal-title").html(options.title);
			}

			if (buttonStr.length) {
				body.after(templates.footer);
				dialog.find(".modal-footer").html(buttonStr);
			}


			/**
			 * Bootstrap event listeners; used handle extra
			 * setup & teardown required after the underlying
			 * modal has performed certain actions
			 */

			dialog.on("hidden.bs.modal", function(e) {
				// ensure we don't accidentally intercept hidden events triggered
				// by children of the current dialog. We shouldn't anymore now BS
				// namespaces its events; but still worth doing
				if (e.target === this) {
					dialog.remove();
				}
			});


			dialog.on("shown.bs.modal", function() {
				dialog.find(".btn-primary:first").focus();
			});

			dialog.on("escape.close.bb", function(e) {
				if (callbacks.onEscape) {
					processCallback(e, dialog, callbacks.onEscape);
				}
			});

			/**
			 * Standard jQuery event listeners; used to handle user
			 * interaction with our dialog
			 */

			dialog.on("click", ".modal-footer button", function(e) {
				var callbackKey = $(this).data("bb-handler");

				processCallback(e, dialog, callbacks[callbackKey]);
			});

			dialog.on("click", ".bootbox-close-button", function(e) {
				// onEscape might be falsy but that's fine; the fact is
				// if the user has managed to click the close button we
				// have to close the dialog, callback or not
				processCallback(e, dialog, callbacks.onEscape);
			});

			dialog.on("keyup", function(e) {
				if (e.which === 27) {
					dialog.trigger("escape.close.bb");
				}
			});

			// the remainder of this method simply deals with adding our
			// dialogent to the DOM, augmenting it with Bootstrap's modal
			// functionality and then giving the resulting object back
			// to our caller

			$(options.container).append(dialog);

			dialog.modal({
				backdrop: options.backdrop ? "static": false,
						keyboard: false,
						show: false
			});

			if (options.show) {
				dialog.modal("show");
			}

		},
	});


	//endof Gonrin.Dialog
	return Gonrin;
}));