/**
 * 模块一：菜单浏览
 * 顶部餐厅信息 + 分类标签（凉菜/热炒/主食/汤羹/饮品）+ 菜品卡片网格。
 */
(function (global) {
  'use strict';

  var S = global.OrderingStore;
  var C = global.OrderingComponents;
  var D = global.OrderingData;

  var CategoryTabs = {
    name: 'CategoryTabs',
    computed: {
      categories: function () {
        return [{ id: 'all', name: '全部', icon: '🍱' }].concat(D.CATEGORIES);
      },
      active: function () { return S.state.activeCategory; }
    },
    methods: {
      count: function (id) { return S.categoryCount(id); },
      pick: function (id) {
        S.pickCategory(id);
        this.$emit('picked', id);
      }
    },
    template:
      '<nav class="tabs" aria-label="菜品分类">' +
      '  <button v-for="c in categories" :key="c.id" type="button" class="tabs__item"' +
      '          :class="{ \'tabs__item--active\': active === c.id }"' +
      '          :aria-pressed="active === c.id" @click="pick(c.id)">' +
      '    <span class="tabs__icon">{{ c.icon }}</span>' +
      '    <span class="tabs__name">{{ c.name }}</span>' +
      '    <span class="tabs__count">{{ count(c.id) }}</span>' +
      '  </button>' +
      '</nav>'
  };

  var DishCard = {
    name: 'DishCard',
    props: { dish: { type: Object, required: true } },
    components: {},
    computed: {
      qty: function () { return S.qtyOf(this.dish.id); },
      salesText: function () { return '月售 ' + this.dish.monthlySales; }
    },
    methods: {
      add: function () { S.addToCart(this.dish.id, 1); },
      remove: function () { S.decreaseFromCart(this.dish.id); }
    },
    template:
      '<article class="card">' +
      '  <dish-thumb :gradient="dish.gradient" :name="dish.name" size="md"></dish-thumb>' +
      '  <div class="card__body">' +
      '    <div class="card__head">' +
      '      <h3 class="card__name">{{ dish.name }}</h3>' +
      '      <span v-if="dish.tags && dish.tags.length" class="card__tag">{{ dish.tags[0] }}</span>' +
      '    </div>' +
      '    <p class="card__desc">{{ dish.desc }}</p>' +
      '    <div class="card__meta">' +
      '      <span class="card__sales">{{ salesText }}</span>' +
      '      <spicy-tag :level="dish.spicy"></spicy-tag>' +
      '    </div>' +
      '    <div class="card__foot">' +
      '      <span class="price"><em>¥</em>{{ dish.price }}</span>' +
      '      <qty-stepper :qty="qty" @add="add" @remove="remove"></qty-stepper>' +
      '    </div>' +
      '  </div>' +
      '</article>'
  };

  var MenuView = {
    name: 'MenuView',
    components: {
      CategoryTabs: CategoryTabs,
      DishCard: DishCard,
      SpicyTag: C.SpicyTag,
      DishThumb: C.DishThumb,
      QtyStepper: C.QtyStepper,
      EmptyState: C.EmptyState
    },
    computed: {
      restaurant: function () { return D.RESTAURANT; },
      keyword: {
        get: function () { return S.state.keyword; },
        set: function (v) { S.state.keyword = v; }
      },
      visible: function () {
        var list = S.dishesByCategory(S.state.activeCategory);
        var kw = S.state.keyword.trim();
        if (!kw) return list;
        return list.filter(function (d) { return d.name.indexOf(kw) >= 0 || d.desc.indexOf(kw) >= 0; });
      },
      groupTitles: function () {
        // 当处于「全部」时按分类分段展示，方便浏览
        return S.state.activeCategory === 'all';
      },
      /** 分段展示用的分类列表（全部/搜索命中时按此顺序分组） */
      sections: function () { return D.CATEGORIES; }
    },
    methods: {
      dishesIn: function (categoryId) {
        return this.visible.filter(function (d) { return d.categoryId === categoryId; });
      },
      clearKeyword: function () { S.state.keyword = ''; }
    },
    template:
      '<section class="menu" aria-label="菜单浏览">' +
      '  <header class="hero">' +
      '    <div class="hero__text">' +
      '      <h1 class="hero__title">{{ restaurant.name }}</h1>' +
      '      <p class="hero__slogan">{{ restaurant.slogan }}</p>' +
      '    </div>' +
      '    <p class="hero__notice">{{ restaurant.notice }}</p>' +
      '  </header>' +

      '  <div class="toolbar">' +
      '    <label class="search">' +
      '      <span class="search__icon" aria-hidden="true">🔍</span>' +
      '      <input class="search__input" type="search" v-model="keyword" placeholder="搜索菜名 / 口味"' +
      '             aria-label="搜索菜品" />' +
      '      <button v-if="keyword" class="search__clear" type="button" @click="clearKeyword"' +
      '              aria-label="清除搜索">×</button>' +
      '    </label>' +
      '  </div>' +

      '  <category-tabs></category-tabs>' +

      '  <template v-if="visible.length">' +
      '    <template v-if="groupTitles">' +
      '      <section v-for="c in sections" :key="c.id" class="group" v-show="dishesIn(c.id).length">' +
      '        <h2 class="group__title"><span class="group__bar"></span>{{ c.name }}' +
      '          <small class="group__sub">{{ dishesIn(c.id).length }} 道</small></h2>' +
      '        <div class="grid">' +
      '          <dish-card v-for="d in dishesIn(c.id)" :key="d.id" :dish="d"></dish-card>' +
      '        </div>' +
      '      </section>' +
      '    </template>' +
      '    <div v-else class="grid">' +
      '      <dish-card v-for="d in visible" :key="d.id" :dish="d"></dish-card>' +
      '    </div>' +
      '  </template>' +
      '  <empty-state v-else icon="🥣" text="没有找到相关菜品，换个关键词试试"></empty-state>' +
      '</section>'
  };

  global.OrderingViews = global.OrderingViews || {};
  global.OrderingViews.MenuView = MenuView;
  global.OrderingViews.CategoryTabs = CategoryTabs;
  global.OrderingViews.DishCard = DishCard;
})(window);
